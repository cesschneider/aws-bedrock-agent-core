import * as crypto from "crypto";

/**
 * JWT authentication for the chat-handler's Lambda Function URL
 * (spec Section 4.4). Function URLs have no built-in JWT authorizer, so
 * validation lives in application code — the Function URL auth type is
 * AWS_NONE and the Authorization header is checked here.
 *
 * The handler must cache the Cognito JWKS with a TTL and explicitly handle
 * expired tokens, clock skew, wrong audience, and malformed claims (Eng
 * review finding). This module uses Node's built-in crypto to avoid adding a
 * JWT dependency that could bloat the Lambda bundle.
 */

// Cognito region and pool ID come from env vars at Lambda init time
let issuer = "";
let audience = "";
let jwksUri = "";
let jwksCache: { keys: crypto.JsonWebKey[] } | null = null;
let jwksCacheTs = 0;
const JWKS_TTL_MS = 60_000; // 1 minute TTL on JWKS cache

export interface AuthResult {
  userId: string;
  departments: string[];
  /** Tenant (organization) the user belongs to — derived from the verified JWT. */
  tenantId: string;
}

export function init(region: string, userPoolId: string, clientId: string): void {
  issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  audience = clientId;
  jwksUri = `${issuer}/.well-known/jwks.json`;
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

type JwtClaims = Record<string, unknown>;

function decodeJwt(token: string): { header: JwtClaims; payload: string; signature: Uint8Array } {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  return {
    header: JSON.parse(base64UrlDecode(headerB64)) as JwtClaims,
    payload: base64UrlDecode(payloadB64),
    signature: base64UrlToBytes(sigB64),
  };
}

function base64UrlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

async function fetchJwks(): Promise<{ keys: crypto.JsonWebKey[] }> {
  if (jwksCache && Date.now() - jwksCacheTs < JWKS_TTL_MS) {
    return jwksCache;
  }
  const resp = await fetch(jwksUri);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  jwksCache = (await resp.json()) as { keys: crypto.JsonWebKey[] };
  jwksCacheTs = Date.now();
  return jwksCache;
}

function verifySignature(
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

export async function authenticate(authHeader: string | undefined): Promise<AuthResult> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw Object.assign(new Error("Missing or invalid Authorization header"), { statusCode: 401 });
  }

  const token = authHeader.slice(7);
  const { header, payload: rawPayload } = decodeJwt(token);
  const payload = JSON.parse(rawPayload);

  const now = Math.floor(Date.now() / 1000);
  const clockSkew = 30; // seconds

  // Validate issuer and audience
  if (payload.iss !== issuer) {
    throw Object.assign(
      new Error(`Wrong token issuer: expected ${issuer}, got ${payload.iss}`),
      { statusCode: 401 }
    );
  }
  if (payload.aud !== audience && payload.client_id !== audience) {
    throw Object.assign(
      new Error(`Wrong token audience: expected ${audience}`),
      { statusCode: 401 }
    );
  }

  // Validate expiration with clock-skew tolerance
  if (payload.exp && payload.exp < now - clockSkew) {
    throw Object.assign(new Error("Token expired"), { statusCode: 401 });
  }

  // Validate not-before with clock-skew tolerance
  if (payload.nbf && payload.nbf > now + clockSkew) {
    throw Object.assign(new Error("Token not yet valid"), { statusCode: 401 });
  }

  // Verify signature against Cognito's JWKS
  const kid = (header as Record<string, string>).kid;
  if (!kid) throw Object.assign(new Error("Token missing kid header"), { statusCode: 401 });

  const jwks = await fetchJwks();
  const key = jwks.keys.find((k) => k.kid === kid);
  if (!key) {
    throw Object.assign(new Error(`JWK with kid ${kid} not found — rotate JWKS cache`), {
      statusCode: 401,
    });
  }

  const [headerB64, payloadB64, sigB64] = token.split(".");
  const sigValid = verifySignature(`${headerB64}.${payloadB64}`, base64UrlToBytes(sigB64), key);
  if (!sigValid) {
    throw Object.assign(new Error("Invalid token signature"), { statusCode: 401 });
  }

  // Extract department claims (cognito:groups)
  const sub = payload.sub ?? payload.username ?? "unknown";
  const rawGroups = payload["cognito:groups"];
  const groups: string[] = Array.isArray(rawGroups)
    ? rawGroups
    : typeof rawGroups === "string"
      ? rawGroups.split(",").map((g: string) => g.trim())
      : [];
  const departments = Array.from(new Set([...groups, "company-wide"]));

  // Extract the tenant claim (multi-tenant design §4.1). The tenant is
  // emitted by pre-token-generation as a custom claim; it is mandatory for
  // retrieval scoping and must never be derived from the request body.
  const tenantId = payload["custom:tenantId"];
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw Object.assign(new Error("Token missing tenant claim (custom:tenantId)"), {
      statusCode: 401,
    });
  }

  return { userId: sub, departments, tenantId: tenantId.trim() };
}

