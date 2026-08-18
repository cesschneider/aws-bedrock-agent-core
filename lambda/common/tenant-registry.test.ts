import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  activateTenant,
  createTenant,
  getTenant,
  resolveTenantId,
  tenantIdFromDomain,
  TenantRegistryError,
} from "./tenant-registry";

/**
 * STORY-B2 tests — tenant registry (domain → tenantId) with fail-closed
 * resolution and admin-email-confirmation activation.
 */

const TABLE = "TenantRegistry";

function makeDynamo(): DynamoDBClient {
  return {
    send: jest.fn(),
  } as unknown as DynamoDBClient;
}

describe("tenantIdFromDomain", () => {
  it("replaces dots with dashes", () => {
    expect(tenantIdFromDomain("acme.com")).toBe("acme-com");
  });
});

describe("resolveTenantId", () => {
  it("returns the tenantId for an ACTIVE tenant", async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Item: {
        domain: { S: "acme.com" },
        tenantId: { S: "acme-com" },
        name: { S: "Acme" },
        status: { S: "ACTIVE" },
        adminEmail: { S: "admin@acme.com" },
        createdAt: { S: "2026-01-01T00:00:00Z" },
      },
    });
    await expect(resolveTenantId(dynamo, TABLE, "acme.com")).resolves.toBe("acme-com");
  });

  it("fails closed on an unknown domain", async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: undefined });
    await expect(resolveTenantId(dynamo, TABLE, "unknown.com")).rejects.toThrow(TenantRegistryError);
  });

  it("fails closed on a PENDING (unconfirmed) tenant", async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Item: {
        domain: { S: "acme.com" },
        tenantId: { S: "acme-com" },
        name: { S: "Acme" },
        status: { S: "PENDING" },
        adminEmail: { S: "admin@acme.com" },
        createdAt: { S: "2026-01-01T00:00:00Z" },
      },
    });
    await expect(resolveTenantId(dynamo, TABLE, "acme.com")).rejects.toThrow(/not active/i);
  });
});

describe("createTenant", () => {
  it("creates a PENDING tenant with a canonical tenantId", async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({});
    const record = await createTenant(dynamo, TABLE, {
      domain: "Acme.COM",
      name: "Acme",
      adminEmail: "admin@acme.com",
      verificationToken: "tok-123",
    });
    expect(record.status).toBe("PENDING");
    expect(record.tenantId).toBe("acme-com");
    expect(record.domain).toBe("acme.com"); // lowercased
  });
});

describe("activateTenant", () => {
  it("activates a PENDING tenant with the correct token", async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock)
      .mockResolvedValueOnce({
        Item: {
          domain: { S: "acme.com" },
          tenantId: { S: "acme-com" },
          name: { S: "Acme" },
          status: { S: "PENDING" },
          adminEmail: { S: "admin@acme.com" },
          verificationToken: { S: "tok-123" },
          createdAt: { S: "2026-01-01T00:00:00Z" },
        },
      })
      .mockResolvedValueOnce({});
    const record = await activateTenant(dynamo, TABLE, "acme.com", "tok-123");
    expect(record.status).toBe("ACTIVE");
  });

  it("rejects an invalid verification token", async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Item: {
        domain: { S: "acme.com" },
        tenantId: { S: "acme-com" },
        name: { S: "Acme" },
        status: { S: "PENDING" },
        adminEmail: { S: "admin@acme.com" },
        verificationToken: { S: "tok-123" },
        createdAt: { S: "2026-01-01T00:00:00Z" },
      },
    });
    await expect(activateTenant(dynamo, TABLE, "acme.com", "wrong")).rejects.toThrow(
      /invalid or expired/i
    );
  });

  it("rejects activation for an unknown domain", async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: undefined });
    await expect(activateTenant(dynamo, TABLE, "unknown.com", "tok")).rejects.toThrow(
      TenantRegistryError
    );
  });

  it("is idempotent for an already-ACTIVE tenant", async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Item: {
        domain: { S: "acme.com" },
        tenantId: { S: "acme-com" },
        name: { S: "Acme" },
        status: { S: "ACTIVE" },
        adminEmail: { S: "admin@acme.com" },
        createdAt: { S: "2026-01-01T00:00:00Z" },
      },
    });
    const record = await activateTenant(dynamo, TABLE, "acme.com", "tok");
    expect(record.status).toBe("ACTIVE");
    // No update call issued (only the initial get).
    expect(dynamo.send).toHaveBeenCalledTimes(1);
  });
});

describe("getTenant", () => {
  it("returns undefined for a missing record", async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: undefined });
    await expect(getTenant(dynamo, TABLE, "acme.com")).resolves.toBeUndefined();
  });
});
