import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handleSignup, handleConfirm } from "./index";

/**
 * STORY-B2 provisioning handler tests — sign-up and admin-email confirmation.
 * The DynamoDB client and email sender are mocked at module boundaries.
 */

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(),
}));

const mockCreateTenant = jest.fn();
const mockActivateTenant = jest.fn();
jest.mock("../common/tenant-registry", () => {
  const actual = jest.requireActual("../common/tenant-registry");
  return {
    ...actual,
    createTenant: (...args: unknown[]) => mockCreateTenant(...args),
    activateTenant: (...args: unknown[]) => mockActivateTenant(...args),
    getTenant: jest.fn(),
  };
});

function makeEvent(body: unknown, path = "/signup"): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    body: JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("handleSignup", () => {
  it("creates a PENDING tenant and emails the admin", async () => {
    mockCreateTenant.mockResolvedValue({
      domain: "acme.com",
      tenantId: "acme-com",
      status: "PENDING",
    });
    const sendEmail = jest.fn().mockResolvedValue(undefined);

    const res = await handleSignup(
      makeEvent({ name: "Acme", adminEmail: "admin@acme.com", domain: "acme.com" }),
      sendEmail
    );

    expect(res.statusCode).toBe(201);
    expect(sendEmail).toHaveBeenCalled();
    expect(mockCreateTenant).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ domain: "acme.com", adminEmail: "admin@acme.com" })
    );
  });

  it("rejects an admin email not on the claimed domain (400)", async () => {
    const sendEmail = jest.fn();
    const res = await handleSignup(
      makeEvent({ name: "Acme", adminEmail: "admin@other.com", domain: "acme.com" }),
      sendEmail
    );
    expect(res.statusCode).toBe(400);
    expect(mockCreateTenant).not.toHaveBeenCalled();
  });

  it("rejects a missing name (400)", async () => {
    const res = await handleSignup(
      makeEvent({ adminEmail: "admin@acme.com", domain: "acme.com" }),
      jest.fn()
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 409 on duplicate domain", async () => {
    mockCreateTenant.mockRejectedValue(
      Object.assign(new Error("dup"), { name: "ConditionalCheckFailedException" })
    );
    const res = await handleSignup(
      makeEvent({ name: "Acme", adminEmail: "admin@acme.com", domain: "acme.com" }),
      jest.fn()
    );
    expect(res.statusCode).toBe(409);
  });
});

describe("handleConfirm", () => {
  it("activates the tenant with a valid token", async () => {
    mockActivateTenant.mockResolvedValue({
      domain: "acme.com",
      tenantId: "acme-com",
      status: "ACTIVE",
    });
    const res = await handleConfirm(makeEvent({ domain: "acme.com", token: "tok" }, "/confirm"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string).status).toBe("ACTIVE");
  });

  it("rejects an invalid token (400)", async () => {
    const { TenantRegistryError } = jest.requireActual("../common/tenant-registry");
    mockActivateTenant.mockRejectedValue(new TenantRegistryError("Invalid or expired verification token"));
    const res = await handleConfirm(makeEvent({ domain: "acme.com", token: "bad" }, "/confirm"));
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing token (400)", async () => {
    const res = await handleConfirm(makeEvent({ domain: "acme.com" }, "/confirm"));
    expect(res.statusCode).toBe(400);
  });
});
