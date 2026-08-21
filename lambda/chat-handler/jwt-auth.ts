import * as crypto from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { tenantOrgWide } from "../common/auth";
import { resolveTenantFromMembership } from "../common/membership-store";

/**
 * JWT authentication for the chat-handler's Lambda Function URL
 * (spec Section 4.4). Function URLs have no built-in JWT authorizer, so
 * validation lives in application code — the Function URL auth type is
 * AWS_NONE and the Authorization header is checked here.
 *
 * DUAL-ISSUER support: the frontend may authenticate with either
 *   - a Cognito ID token (RS256, issuer `https://cognito-idp.<region>.amazonaws.com/<pool>`), or
 *   - a Lovable Cloud / Supabase access token (ES256, issuer `https://<ref>.supabase.co/auth/v1`).
 *
 * The token is routed by its `iss` claim before signature verification, so
 * each issuer is validated against its own JWKS. For Supabase tokens the
 * tenant is resolved from the membership table by email (there is no
 * `custom:tenantId` claim); for Cognito tokens the tenant comes from the
 * `custom:tenantId` claim emitted by pre-token-generation.
 *
 * The handler must cache JWKS with a TTL and explicitly handle expired
 * tokens, clock skew, wrong audience, and malformed claims (Eng review
 * finding). This module uses Node's built-in crypto to avoid adding a JWT
 * dependency that could bloat the Lambda bundle.
 */

// Cognito config
let cognitoIssuer = "";
let cognitoAudience = "";
let cognitoJwksUri = "";

// Supabase (Lovable Cloud) config
let supabaseIssuer = "";
let supabaseJwksUri = "";

// Membership resolution (Supabase path)
let membershipTableName = "";
let dynamo: DynamoDBClient | null = null;

// JWKS caches (separate per issuer)
let cognitoJwksCache: { keys: crypto.JsonWebKey[] } | null = null;
let cognitoJwksCacheTs = 0;
let supabaseJwksCache: { keys: crypto.JsonWebKey[] } | null = null;
let supabaseJwksCacheTs = 0;
const JWKS_TTL_MS = 60_000; // 1 minute TTL on JWKS cache

export interface AuthResult {
  userId: string;
  /** Email when present (Supabase tokens always carry it; Cognito may not). */
  email?: string;
  /** Tenant (organization) the user belongs to — resolved from the token or membership. */
  tenantId: string;
  departments: string[];
}

export interface AuthInitOptions {
  region: string;
  userPoolId: string;
  clientId: string;
  /** Supabase project ref (e.g. `lxqsievatwcbxhwhubkc`) — enables the Supabase path. */
  supabaseProjectRef?: string;
  /** Membership table name — required to resolve tenant for Supabase tokens. */
  membershipTableName?: string;
  /** DynamoDB client for membership lookups (Supabase path). */
  dynamo?: DynamoDBClient;
}

export function init(opts: AuthInitOptions): void {
  cognitoIssuer = `https://cognito-idp.${opts.region}.amazonaws.com/${opts.userPoolId}`;
  cognitoAudience = opts.clientId;
  cognitoJwksUri = `${cognitoIssuer}/.well-known/jwks.json`;

  if (opts.supabaseProjectRef) {
    supabaseIssuer = `https://${opts.supabaseProjectRef}.supabase.co/auth/v1`;
    supabaseJwksUri = `${supabaseIssuer}/.well-known/jwks.json`;
  }
  membershipTableName = opts.membershipTableName ?? "";
  dynamo = opts.dynamo ?? null;
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function base64UrlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

type JwtClaims = Record<string, unknown>;

function decodeJwt(token: string): { header: JwtClaims; payload: JwtClaims } {
  const [headerB64, payloadB64] = token.split(".");
  return {
    header: JSON.parse(base64UrlDecode(headerB64)) as JwtClaims,
    payload: JSON.parse(base64UrlDecode(payloadB64)) as JwtClaims,
  };
}

async function fetchJwks(
  uri: string,
  cache: { keys: crypto.JsonWebKey[] } | null,
  cacheTs: number
): Promise<{ keys: crypto.JsonWebKey[] }> {
  if (cache && Date.now() - cacheTs < JWKS_TTL_MS) {
    return cache;
  }
  const resp = await fetch(uri);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  return (await resp.json()) as { keys: crypto.JsonWebKey[] };
}

function verifyRsaSignature(
  signInput: string,
  signature: Uint8Array,
  publicKey: crypto.JsonWebKey
): boolean {
  try {
    const key = crypto.createPublicKey({ key: publicKey, format: "jwk" });
    const verify = crypto.createVerify("RSA-SHA256");
    verify.update(signInput);
    return verify.verify(key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Verifies an ES256 (P-256) signature. JWT ES256 signatures are the raw
 * R||S concatenation (64 bytes), but Node's crypto.verify expects DER by
 * default — so we pass `dsaEncoding: "ieee-p1363"` to accept the raw form.
 */
function verifyEs256Signature(
  signInput: string,
  signature: Uint8Array,
  publicKey: crypto.JsonWebKey
): boolean {
  try {
    const key = crypto.createPublicKey({ key: publicKey, format: "jwk" });
    const verify = crypto.createVerify("SHA256");
    verify.update(signInput);
    verify.end();
    return verify.verify(
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

function validateTimeClaims(payload: JwtClaims): void {
  const now = Math.floor(Date.now() / 1000);
  const clockSkew = 30; // seconds
  if (payload.exp && (payload.exp as number) < now - clockSkew) {
    throw Object.assign(new Error("Token expired"), { statusCode: 401 });
  }
  if (payload.nbf && (payload.nbf as number) > now + clockSkew) {
    throw Object.assign(new Error("Token not yet valid"), { statusCode: 401 });
  }
}

function findKey(
  jwks: { keys: crypto.JsonWebKey[] },
  kid: string
): crypto.JsonWebKey | undefined {
  return jwks.keys.find((k) => k.kid === kid);
}

async function verifyCognitoToken(
  token: string,
  header: JwtClaims,
  payload: JwtClaims
): Promise<void> {
  if (payload.iss !== cognitoIssuer) {
    throw Object.assign(
      new Error(`Wrong token issuer: expected ${cognitoIssuer}, got ${payload.iss}`),
      { statusCode: 401 }
    );
  }
  if (payload.aud !== cognitoAudience && payload.client_id !== cognitoAudience) {
    throw Object.assign(
      new Error(`Wrong token audience: expected ${cognitoAudience}`),
      { statusCode: 401 }
    );
  }
  validateTimeClaims(payload);

  const kid = (header as Record<string, string>).kid;
  if (!kid) throw Object.assign(new Error("Token missing kid header"), { statusCode: 401 });

  let jwks = await fetchJwks(cognitoJwksUri, cognitoJwksCache, cognitoJwksCacheTs);
  let key = findKey(jwks, kid);
  if (!key) {
    // Key rotation: force a refetch once.
    jwks = await fetchJwks(cognitoJwksUri, null, 0);
    key = findKey(jwks, kid);
  }
  cognitoJwksCache = jwks;
  cognitoJwksCacheTs = Date.now();
  if (!key) {
    throw Object.assign(new Error(`JWK with kid ${kid} not found — rotate JWKS cache`), {
      statusCode: 401,
    });
  }

  const [headerB64, payloadB64, sigB64] = token.split(".");
  const sigValid = verifyRsaSignature(
    `${headerB64}.${payloadB64}`,
    base64UrlToBytes(sigB64),
    key
  );
  if (!sigValid) {
    throw Object.assign(new Error("Invalid token signature"), { statusCode: 401 });
  }
}

async function verifySupabaseToken(
  token: string,
  header: JwtClaims,
  payload: JwtClaims
): Promise<void> {
  if (payload.iss !== supabaseIssuer) {
    throw Object.assign(
      new Error(`Wrong token issuer: expected ${supabaseIssuer}, got ${payload.iss}`),
      { statusCode: 401 }
    );
  }
  if (payload.aud !== "authenticated") {
    throw Object.assign(
      new Error(`Wrong token audience: expected "authenticated", got ${payload.aud}`),
      { statusCode: 401 }
    );
  }
  validateTimeClaims(payload);

  const kid = (header as Record<string, string>).kid;
  if (!kid) throw Object.assign(new Error("Token missing kid header"), { statusCode: 401 });

  let jwks = await fetchJwks(supabaseJwksUri, supabaseJwksCache, supabaseJwksCacheTs);
  let key = findKey(jwks, kid);
  if (!key) {
    // Key rotation: force a refetch once.
    jwks = await fetchJwks(supabaseJwksUri, null, 0);
    key = findKey(jwks, kid);
  }
  supabaseJwksCache = jwks;
  supabaseJwksCacheTs = Date.now();
  if (!key) {
    throw Object.assign(new Error(`JWK with kid ${kid} not found — rotate JWKS cache`), {
      statusCode: 401,
    });
  }

  const [headerB64, payloadB64, sigB64] = token.split(".");
  const sigValid = verifyEs256Signature(
    `${headerB64}.${payloadB64}`,
    base64UrlToBytes(sigB64),
    key
  );
  if (!sigValid) {
    throw Object.assign(new Error("Invalid token signature"), { statusCode: 401 });
  }
}

export async function authenticate(authHeader: string | undefined): Promise<AuthResult> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw Object.assign(new Error("Missing or invalid Authorization header"), { statusCode: 401 });
  }

  const token = authHeader.slice(7);
  const { header, payload } = decodeJwt(token);

  const iss = payload.iss as string | undefined;
  if (!iss) {
    throw Object.assign(new Error("Token missing issuer (iss) claim"), { statusCode: 401 });
  }

  if (iss === cognitoIssuer) {
    await verifyCognitoToken(token, header, payload);

    const sub = (payload.sub ?? payload.username ?? "unknown") as string;
    const rawGroups = payload["cognito:groups"];
    const groups: string[] = Array.isArray(rawGroups)
      ? rawGroups
      : typeof rawGroups === "string"
        ? rawGroups.split(",").map((g: string) => g.trim())
        : [];

    const tenantId = payload["custom:tenantId"];
    if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
      throw Object.assign(new Error("Token missing tenant claim (custom:tenantId)"), {
        statusCode: 401,
      });
    }

    const departments = Array.from(new Set([...groups, tenantOrgWide(tenantId.trim())]));
    return { userId: sub, tenantId: tenantId.trim(), departments };
  }

  if (iss === supabaseIssuer) {
    await verifySupabaseToken(token, header, payload);

    const email = payload.email as string | undefined;
    if (!email || typeof email !== "string" || email.trim().length === 0) {
      throw Object.assign(new Error("Supabase token missing email claim"), { statusCode: 401 });
    }
    const sub = (payload.sub ?? email) as string;

    // Resolve tenant from membership by email (no custom:tenantId claim on
    // Supabase tokens). Fails closed: no membership → no tenant → 401.
    if (!dynamo || !membershipTableName) {
      throw Object.assign(new Error("Membership resolution not configured"), { statusCode: 401 });
    }
    const member = await resolveTenantFromMembership(dynamo, membershipTableName, email);
    if (!member) {
      throw Object.assign(
        new Error("No organization membership found for this account"),
        { statusCode: 401 }
      );
    }

    const departments = [tenantOrgWide(member.tenantId)];
    return { userId: sub, email: email.toLowerCase(), tenantId: member.tenantId, departments };
  }

  throw Object.assign(
    new Error(`Unsupported token issuer: ${iss}`),
    { statusCode: 401 }
  );
}
