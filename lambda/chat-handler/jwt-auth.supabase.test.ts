import * as crypto from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { authenticate, init } from "./jwt-auth";

/**
 * Supabase (Lovable Cloud) token path tests. Supabase signs with ES256
 * (P-256); the tenant is resolved from the membership table by email (there
 * is no `custom:tenantId` claim). These tests use a locally generated P-256
 * keypair and a mocked DynamoDB client.
 */

const SUPABASE_REF = "lxqsievatwcbxhwhubkc";
const SUPABASE_ISSUER = `https://${SUPABASE_REF}.supabase.co/auth/v1`;
const KID = "supabase-test-key";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function signEs256(payload: Record<string, unknown>, kid: string = KID): string {
  const header = { alg: "ES256", typ: "JWT", kid };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signInput = `${headerB64}.${payloadB64}`;
  const signer = crypto.createSign("SHA256");
  signer.update(signInput);
  signer.end();
  // JWT ES256 signature is raw R||S (64 bytes) — use ieee-p1363 encoding.
  const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signInput}.${b64url(signature)}`;
}

function supabasePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: SUPABASE_ISSUER,
    sub: "00000000-0000-0000-0000-000000000001",
    aud: "authenticated",
    exp: now + 3600,
    iat: now - 10,
    email: "alice@acme.com",
    role: "authenticated",
    ...overrides,
  };
}

// Mock DynamoDB: return an ACTIVE admin membership for alice@acme.com.
const dynamo = {
  send: jest.fn().mockResolvedValue({
    Item: {
      email: { S: "alice@acme.com" },
      tenantId: { S: "acme-corporation" },
      role: { S: "admin" },
      status: { S: "ACTIVE" },
    },
  }),
} as unknown as DynamoDBClient;

beforeAll(() => {
  init({
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL",
    clientId: "test-client-id",
    supabaseProjectRef: SUPABASE_REF,
    membershipTableName: "membership-table",
    dynamo,
  });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ keys: [{ ...jwk, kid: KID, alg: "ES256", use: "sig" }] }),
  }) as unknown as typeof fetch;
});

describe("authenticate (Supabase path)", () => {
  it("accepts a valid Supabase token and resolves tenant from membership", async () => {
    const token = signEs256(supabasePayload());
    const result = await authenticate(`Bearer ${token}`);
    expect(result.userId).toBe("00000000-0000-0000-0000-000000000001");
    expect(result.email).toBe("alice@acme.com");
    expect(result.tenantId).toBe("acme-corporation");
    expect(result.departments).toEqual(["acme-corporation:org-wide"]);
  });

  it("rejects a Supabase token with wrong audience (not 'authenticated')", async () => {
    const token = signEs256(supabasePayload({ aud: "something-else" }));
    await expect(authenticate(`Bearer ${token}`)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a Supabase token missing the email claim", async () => {
    const token = signEs256(supabasePayload({ email: undefined }));
    await expect(authenticate(`Bearer ${token}`)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("returns identity with empty tenantId when email has no membership (org-creation flow)", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: undefined });
    const token = signEs256(supabasePayload({ email: "nobody@acme.com" }));
    const identity = await authenticate(`Bearer ${token}`);
    expect(identity.tenantId).toBe("");
    expect(identity.email).toBe("nobody@acme.com");
    expect(identity.departments).toEqual([]);
  });

  it("rejects a Supabase token with a tampered signature", async () => {
    const token = signEs256(supabasePayload());
    const [h, , s] = token.split(".");
    const tampered = b64url(JSON.stringify(supabasePayload({ email: "evil@acme.com" })));
    await expect(authenticate(`Bearer ${h}.${tampered}.${s}`)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("rejects an expired Supabase token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signEs256(supabasePayload({ exp: now - 3600 }));
    await expect(authenticate(`Bearer ${token}`)).rejects.toMatchObject({ statusCode: 401 });
  });
});
