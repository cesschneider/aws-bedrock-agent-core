import * as crypto from "crypto";
import { authenticate, init } from "./jwt-auth";

/**
 * JWT validation tests (Eng review requirement, spec Section 4.4): expired
 * tokens, clock skew, wrong audience, wrong issuer, malformed claims, and
 * missing headers must all be rejected with 401-tagged errors.
 *
 * Uses a locally generated RSA keypair; the JWKS fetch is mocked so no
 * network calls happen.
 */

const REGION = "us-east-1";
const USER_POOL_ID = "us-east-1_TESTPOOL";
const CLIENT_ID = "test-client-id";
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const KID = "test-key-1";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function signToken(payload: Record<string, unknown>, kid: string = KID): string {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signInput = `${headerB64}.${payloadB64}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signInput);
  const signature = signer.sign(privateKey);
  return `${signInput}.${b64url(signature)}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "user-123",
    exp: now + 3600,
    nbf: now - 10,
    "cognito:groups": ["dept-engineering"],
    ...overrides,
  };
}

beforeAll(() => {
  init(REGION, USER_POOL_ID, CLIENT_ID);
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] }),
  }) as unknown as typeof fetch;
});

describe("authenticate", () => {
  it("accepts a valid token and returns userId + departments incl. company-wide", async () => {
    const token = signToken(validPayload());
    const result = await authenticate(`Bearer ${token}`);
    expect(result.userId).toBe("user-123");
    expect(result.departments).toEqual(
      expect.arrayContaining(["dept-engineering", "company-wide"])
    );
  });

  it("rejects a missing Authorization header with 401", async () => {
    await expect(authenticate(undefined)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a non-Bearer Authorization header with 401", async () => {
    await expect(authenticate("Basic abc123")).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects an expired token with 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(validPayload({ exp: now - 3600 }));
    await expect(authenticate(`Bearer ${token}`)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("tolerates expiry within the 30s clock-skew window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(validPayload({ exp: now - 10 }));
    await expect(authenticate(`Bearer ${token}`)).resolves.toBeDefined();
  });

  it("rejects a wrong-audience token with 401", async () => {
    const token = signToken(validPayload({ aud: "some-other-client" }));
    await expect(authenticate(`Bearer ${token}`)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a wrong-issuer token with 401", async () => {
    const token = signToken(validPayload({ iss: "https://evil.example.com" }));
    await expect(authenticate(`Bearer ${token}`)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a token not yet valid (nbf in future beyond skew) with 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signToken(validPayload({ nbf: now + 3600 }));
    await expect(authenticate(`Bearer ${token}`)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a token signed with an unknown kid with 401", async () => {
    const token = signToken(validPayload(), "unknown-kid");
    await expect(authenticate(`Bearer ${token}`)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a tampered payload (signature mismatch) with 401", async () => {
    const token = signToken(validPayload());
    const [h, , s] = token.split(".");
    const tamperedPayload = b64url(JSON.stringify(validPayload({ sub: "attacker" })));
    await expect(authenticate(`Bearer ${h}.${tamperedPayload}.${s}`)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("handles cognito:groups as a comma-separated string", async () => {
    const token = signToken(validPayload({ "cognito:groups": "dept-a, dept-b" }));
    const result = await authenticate(`Bearer ${token}`);
    expect(result.departments).toEqual(
      expect.arrayContaining(["dept-a", "dept-b", "company-wide"])
    );
  });

  it("grants only company-wide when the token has no groups claim", async () => {
    const token = signToken(validPayload({ "cognito:groups": undefined }));
    const result = await authenticate(`Bearer ${token}`);
    expect(result.departments).toEqual(["company-wide"]);
  });
});
