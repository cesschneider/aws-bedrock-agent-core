import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  createOrganization,
  getOrganization,
  isNameAvailable,
  isValidSlug,
  slugFromName,
} from "./organization-store";

const dynamo = { send: jest.fn() } as unknown as DynamoDBClient;

describe("slugFromName", () => {
  it("lowercases and collapses non-alphanumerics to dashes", () => {
    expect(slugFromName("Acme Corporation")).toBe("acme-corporation");
    expect(slugFromName("  Foo & Bar!  ")).toBe("foo-bar");
  });

  it("caps at 64 chars", () => {
    expect(slugFromName("a".repeat(100)).length).toBeLessThanOrEqual(64);
  });
});

describe("isValidSlug", () => {
  it("accepts lowercase alphanumerics and dashes", () => {
    expect(isValidSlug("acme-corporation")).toBe(true);
  });

  it("rejects empty and invalid characters", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("Acme Corp")).toBe(false);
  });
});

describe("isNameAvailable", () => {
  it("returns true when no org exists for the slug", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: undefined });
    expect(await isNameAvailable(dynamo, "t", "Acme Corporation")).toBe(true);
  });

  it("returns false when the slug is taken", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Item: {
        tenantId: { S: "acme-corporation" },
        name: { S: "Acme Corporation" },
        adminEmail: { S: "admin@acme.com" },
        status: { S: "ACTIVE" },
        createdAt: { S: "2026-01-01T00:00:00Z" },
      },
    });
    expect(await isNameAvailable(dynamo, "t", "Acme Corporation")).toBe(false);
  });

  it("returns false for an invalid name", async () => {
    expect(await isNameAvailable(dynamo, "t", "!!!")).toBe(false);
  });
});

describe("createOrganization", () => {
  it("creates an ACTIVE org with a slug tenantId", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({});
    const org = await createOrganization(dynamo, "t", {
      name: "Acme Corporation",
      adminEmail: "Admin@Acme.com",
    });
    expect(org.tenantId).toBe("acme-corporation");
    expect(org.status).toBe("ACTIVE");
    expect(org.adminEmail).toBe("admin@acme.com");
  });

  it("rejects an invalid name", async () => {
    await expect(
      createOrganization(dynamo, "t", { name: "!!!", adminEmail: "a@b.c" })
    ).rejects.toThrow(/Invalid organization name/);
  });
});

describe("getOrganization", () => {
  it("returns undefined for a missing record", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: undefined });
    expect(await getOrganization(dynamo, "t", "acme-corporation")).toBeUndefined();
  });
});
