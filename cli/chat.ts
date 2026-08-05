/**
 * Zero-dependency CLI for the RAG knowledge agent chat endpoint.
 *
 * Run with Node 22's built-in TypeScript type-stripping:
 *   npm run chat -- configure --profile eworkslabs-dev
 *   npm run chat -- login
 *   npm run chat            # starts the interactive chat REPL
 *
 * Subcommands:
 *   configure  Pull the Function URL + Cognito IDs from the deployed stack
 *              (via the aws CLI) and save them to ~/.rag-chat-cli/config.json.
 *   login      USER_PASSWORD_AUTH against Cognito as the native dev test user.
 *              Handles the NEW_PASSWORD_REQUIRED challenge on first login and
 *              persists id/refresh tokens to ~/.rag-chat-cli/creds.json.
 *   chat       Interactive REPL. Maintains sessionId across turns, silently
 *              refreshes expired tokens, prints the answer + citation URLs.
 *
 * No npm dependencies: uses Node 22 native fetch, readline/promises, and fs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import * as readline from "node:readline/promises";

interface CliConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  functionUrl: string;
}

interface AuthResult {
  IdToken?: string;
  AccessToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
}

interface InitiateAuthResponse {
  ChallengeName?: string;
  Session?: string;
  AuthenticationResult?: AuthResult;
}

interface Creds {
  idToken: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  username: string;
}

interface CitationLink {
  referenceId: string;
  url: string;
}

interface ChatResponse {
  answer?: string;
  citations?: CitationLink[];
  sessionId?: string;
  turnId?: string;
  error?: string;
}

const DEV_USERNAME = "dev-tester@example.invalid";

// --- file paths -------------------------------------------------------------

function cliDir(): string {
  return path.join(os.homedir(), ".rag-chat-cli");
}
function configPath(): string {
  return path.join(cliDir(), "config.json");
}
function credsPath(): string {
  return path.join(cliDir(), "creds.json");
}

function loadJson<T>(p: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function saveJson(p: string, data: unknown): void {
  fs.mkdirSync(cliDir(), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function loadConfigOrThrow(): CliConfig {
  const c = loadJson<CliConfig>(configPath());
  if (!c || !c.functionUrl || !c.clientId || !c.region) {
    throw new Error(
      `No config found at ${configPath()}. Run: npm run chat -- configure --profile eworkslabs-dev`
    );
  }
  return c;
}

function loadCredsOrThrow(): Creds {
  const c = loadJson<Creds>(credsPath());
  if (!c || !c.idToken) {
    throw new Error(`Not logged in. Run: npm run chat -- login`);
  }
  return c;
}

// --- Cognito (raw fetch, no SDK / no SigV4 needed for InitiateAuth) ---------

async function cognitoCall<T>(
  region: string,
  target: string,
  body: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": target,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = JSON.parse(text || "{}") as T;
  if (!res.ok) {
    const err = parsed as unknown as { message?: string };
    throw new Error(
      `Cognito ${target.split(".").pop() ?? target} failed (${res.status}): ${
        err.message ?? res.statusText
      }`
    );
  }
  return parsed;
}

function deriveRegionFromUserPool(userPoolId: string): string | undefined {
  // User Pool IDs look like "us-east-1_abc123" — the region is the prefix.
  const idx = userPoolId.indexOf("_");
  return idx > 0 ? userPoolId.slice(0, idx) : undefined;
}

// --- token refresh ----------------------------------------------------------

async function refreshTokens(config: CliConfig, creds: Creds): Promise<Creds> {
  if (!creds.refreshToken) {
    throw new Error("No refresh token; run `npm run chat -- login` again.");
  }
  const resp = await cognitoCall<InitiateAuthResponse>(
    config.region,
    "AWSCognitoIdentityProviderService.InitiateAuth",
    {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: config.clientId,
      AuthParameters: { REFRESH_TOKEN: creds.refreshToken },
    }
  );
  const ar = resp.AuthenticationResult;
  if (!ar?.IdToken) {
    throw new Error("Token refresh failed: no IdToken returned.");
  }
  return {
    idToken: ar.IdToken,
    accessToken: ar.AccessToken ?? creds.accessToken,
    // Cognito does not always return a new refresh token; keep the old one.
    refreshToken: ar.RefreshToken ?? creds.refreshToken,
    expiresAt: Date.now() + (ar.ExpiresIn ?? 3600) * 1000,
    username: creds.username,
  };
}

async function refreshIfNeeded(config: CliConfig, creds: Creds): Promise<Creds> {
  if (Date.now() < creds.expiresAt - 60_000) return creds;
  console.log("(token expired; refreshing...)");
  const next = await refreshTokens(config, creds);
  saveJson(credsPath(), next);
  return next;
}

// --- chat endpoint ----------------------------------------------------------

async function callChat(
  functionUrl: string,
  idToken: string,
  message: string,
  sessionId: string | undefined
): Promise<ChatResponse> {
  const body: Record<string, unknown> = { message };
  if (sessionId) body.sessionId = sessionId;
  const res = await fetch(functionUrl, {
    method: "POST",
    // Header name lowercased to match the handler's event.headers["authorization"] read.
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = JSON.parse(text || "{}") as ChatResponse;
  if (!res.ok) {
    throw new Error(`Chat request failed (${res.status}): ${json.error ?? res.statusText}`);
  }
  return json;
}

// --- prompt helpers ---------------------------------------------------------

async function prompt(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(query);
  rl.close();
  return answer;
}

/** Prompt for a password with masked input (requires a TTY). */
function promptHidden(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      console.error("(stdin is not a TTY — password input will be visible)");
      prompt(query).then(resolve, reject);
      return;
    }
    process.stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const chars: string[] = [];
    const onData = (ch: string): void => {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 13 || code === 10) {
        // Enter
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(chars.join(""));
      } else if (code === 3) {
        // Ctrl-C
        process.stdout.write("\n");
        process.exit(1);
      } else if (code === 127 || code === 8) {
        // Backspace
        if (chars.length > 0) {
          chars.pop();
          process.stdout.write("\b \b");
        }
      } else {
        chars.push(ch);
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

// --- subcommands ------------------------------------------------------------

async function cmdConfigure(opts: {
  profile: string;
  stack: string;
  region?: string;
}): Promise<void> {
  const args = [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    opts.stack,
    "--profile",
    opts.profile,
    "--output",
    "json",
    "--query",
    "Stacks[0].Outputs",
  ];
  if (opts.region) args.push("--region", opts.region);

  let out: string;
  try {
    out = execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `aws CLI failed: ${(e.stderr ?? e.message ?? String(err)).trim()}\n` +
        `Make sure the aws CLI is installed and the profile '${opts.profile}' is configured.`
    );
  }

  const outputs = JSON.parse(out || "[]") as Array<{ OutputKey: string; OutputValue: string }>;
  const byKey = new Map(outputs.map((o) => [o.OutputKey, o.OutputValue]));
  const functionUrl = byKey.get("ChatHandlerFunctionUrl");
  const userPoolId = byKey.get("CognitoUserPoolId");
  const clientId = byKey.get("CognitoClientId");
  if (!functionUrl || !userPoolId || !clientId) {
    throw new Error(
      `Stack '${opts.stack}' is missing expected outputs (ChatHandlerFunctionUrl, CognitoUserPoolId, CognitoClientId).\n` +
        `Found: ${[...byKey.keys()].join(", ") || "(none)"}`
    );
  }
  const region = opts.region ?? deriveRegionFromUserPool(userPoolId) ?? "us-east-1";

  const config: CliConfig = { region, userPoolId, clientId, functionUrl };
  saveJson(configPath(), config);
  console.log(`Saved config to ${configPath()}`);
  console.log(`  Function URL : ${functionUrl}`);
  console.log(`  User Pool ID : ${userPoolId}`);
  console.log(`  Client ID    : ${clientId}`);
  console.log(`  Region       : ${region}`);
  console.log(`\nNext: npm run chat -- login`);
}

async function cmdLogin(config: CliConfig): Promise<void> {
  const entered = await prompt(`Username [${DEV_USERNAME}]: `);
  const username = entered.trim() || DEV_USERNAME;
  const password = process.env.RAG_CLI_PASSWORD ?? (await promptHidden("Password: "));

  const resp = await cognitoCall<InitiateAuthResponse>(
    config.region,
    "AWSCognitoIdentityProviderService.InitiateAuth",
    {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: config.clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }
  );

  let ar = resp.AuthenticationResult;
  if (resp.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    const newPw = process.env.RAG_CLI_NEW_PASSWORD ?? (await promptHidden("New permanent password: "));
    const r2 = await cognitoCall<InitiateAuthResponse>(
      config.region,
      "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
      {
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: config.clientId,
        Session: resp.Session,
        ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPw },
      }
    );
    ar = r2.AuthenticationResult;
  }

  if (!ar?.IdToken) {
    throw new Error("Login succeeded but no IdToken was returned.");
  }
  const creds: Creds = {
    idToken: ar.IdToken,
    accessToken: ar.AccessToken,
    refreshToken: ar.RefreshToken,
    expiresAt: Date.now() + (ar.ExpiresIn ?? 3600) * 1000,
    username,
  };
  saveJson(credsPath(), creds);
  console.log(
    `Logged in as ${username}. Token saved to ${credsPath()} ` +
      `(expires ${new Date(creds.expiresAt).toISOString()}).\n` +
      `Next: npm run chat`
  );
}

async function cmdChat(config: CliConfig, initialCreds: Creds): Promise<void> {
  let creds = initialCreds;
  let sessionId: string | undefined;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Connected to the RAG agent. Type your question; /help for commands, /quit to exit.\n");

  while (true) {
    const line = await rl.question("you> ");
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === "/quit" || trimmed === "/exit") {
      rl.close();
      break;
    }
    if (trimmed === "/new") {
      sessionId = undefined;
      console.log("(started a new session)\n");
      continue;
    }
    if (trimmed === "/help") {
      printHelp();
      continue;
    }
    if (trimmed === "/tokens") {
      console.log(
        `user: ${creds.username} | expires: ${new Date(creds.expiresAt).toISOString()} | ` +
          `idToken: ${creds.idToken.slice(0, 12)}…\n`
      );
      continue;
    }

    try {
      let resp = await callChat(config.functionUrl, creds.idToken, trimmed, sessionId);
      // On a stale token, refresh once and retry.
      if (resp.error && /401|unauthor/i.test(resp.error)) {
        creds = await refreshTokens(config, creds);
        saveJson(credsPath(), creds);
        resp = await callChat(config.functionUrl, creds.idToken, trimmed, sessionId);
      }
      if (resp.sessionId) sessionId = resp.sessionId;

      console.log(`\nagent> ${resp.answer ?? "(no answer)"}`);
      const cites = resp.citations ?? [];
      if (cites.length > 0) {
        console.log("\ncitations:");
        for (const c of cites) {
          console.log(`  - ${c.referenceId}\n    ${c.url}`);
        }
      }
      console.log();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/401|unauthor/i.test(msg)) {
        try {
          creds = await refreshTokens(config, creds);
          saveJson(credsPath(), creds);
          console.error("(token was stale; refreshed. Please re-send your message.)\n");
        } catch {
          console.error(`error: ${msg}\nRun: npm run chat -- login\n`);
        }
      } else {
        console.error(`error: ${msg}\n`);
      }
    }
  }
}

function printHelp(): void {
  console.log(
    "\ncommands:\n" +
      "  /new     start a new conversation (drops the session ID)\n" +
      "  /tokens  show the current user and token expiry\n" +
      "  /help    show this help\n" +
      "  /quit    exit\n"
  );
}

// --- arg parsing + entry ----------------------------------------------------

function flagValue(name: string): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "chat";

  if (command === "configure") {
    await cmdConfigure({
      profile: flagValue("--profile") ?? "eworkslabs-dev",
      stack: flagValue("--stack") ?? "RagKnowledgeAgent-dev",
      region: flagValue("--region"),
    });
    return;
  }

  if (command === "login") {
    await cmdLogin(loadConfigOrThrow());
    return;
  }

  if (command === "chat" || command === "--") {
    const config = loadConfigOrThrow();
    const creds = await refreshIfNeeded(config, loadCredsOrThrow());
    await cmdChat(config, creds);
    return;
  }

  console.error(
    `Unknown command '${command}'. Usage:\n` +
      "  npm run chat -- configure [--profile eworkslabs-dev] [--stack RagKnowledgeAgent-dev] [--region us-east-1]\n" +
      "  npm run chat -- login\n" +
      "  npm run chat            # interactive chat\n"
  );
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`error: ${(err as Error).message ?? String(err)}`);
  process.exit(1);
});

