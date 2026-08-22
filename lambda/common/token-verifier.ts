import * as crypto from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { tenantOrgWide } from "./auth";
import { resolveTenantFromMembership } from "./membership-store";

/**
 * Shared dual-issuer JWT verification (Cognito RS256 + Supabase/Lovable Cloud
 * ES256). Used by both the chat-handler (Function URL, app-level auth) and the
 * API Gateway Lambda authorizer (gateway-level auth), so there is exactly one
 * validation implementation.
 *
 * Tokens are routed by their `iss` claim before signature verification, so
 * each issuer is validated against its own JWKS. For Supabase tokens the
 * tenant is resolved from the membership table by email (there is no
 * `custom:tenantId` claim); for Cognito tokens the tenant comes from the
 * `custom:tenantId` claim emitted by pre-token-generation.
 *
 * JWKS are cached with a TTL and refetched once on an unknown `kid` (key
 * rotation). Expiry, not-before, audience, and issuer are all validated with
 * clock-skew tolerance. Uses Node's built-in crypto (no JWT dependency).
 */

export interface VerifiedIdentity {
  userId: string;
  /** Email when present (Supabase tokens always carry it; Cognito may not). */
  email?: string;
  /** Tenant (organization) the user belongs to. */
  tenantId: string;
  departments: string[];
}

export interface TokenVerifierConfig {
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

const JWKS_TTL_MS = 60_000; // 1 minute TTL on JWKS cache
const CLOCK_SKEW_S = 30;

type JwtClaims = Record<string, unknown>;

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function base64UrlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function decodeJwt(token: string): { header: JwtClaims; payload: JwtClaims } {
  const [headerB64, payloadB64] = token.split(".");
  return {
    header: JSON.parse(base64UrlDecode(headerB64)) as JwtClaims,
    payload: JSON.parse(base64UrlDecode(payloadB64)) as JwtClaims,
  };
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
    return verify.verify({ key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature));
  } catch {
    return false;
  }
}

function validateTimeClaims(payload: JwtClaims): void {
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && (payload.exp as number) < now - CLOCK_SKEW_S) {
    throw Object.assign(new Error("Token expired"), { statusCode: 401 });
  }
  if (payload.nbf && (payload.nbf as number) > now + CLOCK_SKEW_S) {
    throw Object.assign(new Error("Token not yet valid"), { statusCode: 401 });
  }
}

export class TokenVerifier {
  private readonly cognitoIssuer: string;
  private readonly cognitoAudience: string;
  private readonly cognitoJwksUri: string;
  private readonly supabaseIssuer: string;
  private readonly supabaseJwksUri: string;
  private readonly membershipTableName: string;
  private readonly dynamo: DynamoDBClient | null;

  private cognitoJwksCache: { keys: crypto.JsonWebKey[] } | null = null;
  private cognitoJwksCacheTs = 0;
  private supabaseJwksCache: { keys: crypto.JsonWebKey[] } | null = null;
  private supabaseJwksCacheTs = 0;

  constructor(config: TokenVerifierConfig) {
    this.cognitoIssuer = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
    this.cognitoAudience = config.clientId;
    this.cognitoJwksUri = `${this.cognitoIssuer}/.well-known/jwks.json`;

    this.supabaseIssuer = config.supabaseProjectRef
      ? `https://${config.supabaseProjectRef}.supabase.co/auth/v1`
      : "";
    this.supabaseJwksUri = this.supabaseIssuer
      ? `${this.supabaseIssuer}/.well-known/jwks.json`
      : "";

    this.membershipTableName = config.membershipTableName ?? "";
    this.dynamo = config.dynamo ?? null;
  }

  async verify(authHeader: string | undefined): Promise<VerifiedIdentity> {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw Object.assign(new Error("Missing or invalid Authorization header"), { statusCode: 401 });
    }

    const token = authHeader.slice(7);
    const { header, payload } = decodeJwt(token);

    const iss = payload.iss as string | undefined;
    if (!iss) {
      throw Object.assign(new Error("Token missing issuer (iss) claim"), { statusCode: 401 });
    }

    if (iss === this.cognitoIssuer) {
      return this.verifyCognito(token, header, payload);
    }
    if (iss === this.supabaseIssuer) {
      return this.verifySupabase(token, header, payload);
    }
    throw Object.assign(new Error(`Unsupported token issuer: ${iss}`), { statusCode: 401 });
  }

  private async verifyCognito(
    token: string,
    header: JwtClaims,
    payload: JwtClaims
  ): Promise<VerifiedIdentity> {
    if (payload.aud !== this.cognitoAudience && payload.client_id !== this.cognitoAudience) {
      throw Object.assign(
        new Error(`Wrong token audience: expected ${this.cognitoAudience}`),
        { statusCode: 401 }
      );
    }
    validateTimeClaims(payload);

    await this.resolveKey(
      token,
      header,
      this.cognitoJwksUri,
      () => this.cognitoJwksCache,
      (v) => (this.cognitoJwksCache = v),
      () => this.cognitoJwksCacheTs,
      (v) => (this.cognitoJwksCacheTs = v),
      verifyRsaSignature
    );

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

  private async verifySupabase(
    token: string,
    header: JwtClaims,
    payload: JwtClaims
  ): Promise<VerifiedIdentity> {
    if (payload.aud !== "authenticated") {
      throw Object.assign(
        new Error(`Wrong token audience: expected "authenticated", got ${payload.aud}`),
        { statusCode: 401 }
      );
    }
    validateTimeClaims(payload);

    await this.resolveKey(
      token,
      header,
      this.supabaseJwksUri,
      () => this.supabaseJwksCache,
      (v) => (this.supabaseJwksCache = v),
      () => this.supabaseJwksCacheTs,
      (v) => (this.supabaseJwksCacheTs = v),
      verifyEs256Signature
    );

    const email = payload.email as string | undefined;
    if (!email || typeof email !== "string" || email.trim().length === 0) {
      throw Object.assign(new Error("Supabase token missing email claim"), { statusCode: 401 });
    }
    const sub = (payload.sub ?? email) as string;

    if (!this.dynamo || !this.membershipTableName) {
      throw Object.assign(new Error("Membership resolution not configured"), { statusCode: 401 });
    }
    const member = await resolveTenantFromMembership(this.dynamo, this.membershipTableName, email);
    if (!member) {
      throw Object.assign(new Error("No organization membership found for this account"), {
        statusCode: 401,
      });
    }

    const departments = [tenantOrgWide(member.tenantId)];
    return {
      userId: sub,
      email: email.toLowerCase(),
      tenantId: member.tenantId,
      departments,
    };
  }

  private async resolveKey(
    token: string,
    header: JwtClaims,
    jwksUri: string,
    getCache: () => { keys: crypto.JsonWebKey[] } | null,
    setCache: (v: { keys: crypto.JsonWebKey[] }) => void,
    getTs: () => number,
    setTs: (v: number) => void,
    verifySig: (signInput: string, sig: Uint8Array, key: crypto.JsonWebKey) => boolean
  ): Promise<crypto.JsonWebKey> {
    const kid = (header as Record<string, string>).kid;
    if (!kid) throw Object.assign(new Error("Token missing kid header"), { statusCode: 401 });

    let jwks = await this.fetchJwks(jwksUri, getCache(), getTs());
    let key = jwks.keys.find((k) => k.kid === kid);
    if (!key) {
      // Key rotation: force a refetch once.
      jwks = await this.fetchJwks(jwksUri, null, 0);
      key = jwks.keys.find((k) => k.kid === kid);
    }
    setCache(jwks);
    setTs(Date.now());
    if (!key) {
      throw Object.assign(new Error(`JWK with kid ${kid} not found — rotate JWKS cache`), {
        statusCode: 401,
      });
    }

    const [headerB64, payloadB64, sigB64] = token.split(".");
    const sigValid = verifySig(`${headerB64}.${payloadB64}`, base64UrlToBytes(sigB64), key);
    if (!sigValid) {
      throw Object.assign(new Error("Invalid token signature"), { statusCode: 401 });
    }
    return key;
  }

  private async fetchJwks(
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
}
