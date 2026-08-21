import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  acceptMembership,
  createAdminMembership,
  getMember,
  inviteMember,
  isTenantAdmin,
  listMembers,
  removeMember,
  resolveTenantFromMembership,
} from "./membership-store";

const dynamo = { send: jest.fn() } as unknown as DynamoDBClient;

function memberItem(overrides: Record<string, unknown> = {}) {
  return {
    email: { S: "alice@acme.com" },
    tenantId: { S: "acme-com" },
    role: { S: "member" },
    status: { S: "ACTIVE" },
    ...overrides,
  };
}

describe("getMember / resolveTenantFromMembership", () => {
  it("returns undefined when no membership exists", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: undefined });
    expect(await getMember(dynamo, "t", "alice@acme.com")).toBeUndefined();
  });

  it("resolves an ACTIVE member's tenant", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: memberItem() });
    const member = await resolveTenantFromMembership(dynamo, "t", "alice@acme.com");
    expect(member?.tenantId).toBe("acme-com");
  });

  it("does not resolve a PENDING member", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Item: memberItem({ status: { S: "PENDING" } }),
    });
    expect(await resolveTenantFromMembership(dynamo, "t", "alice@acme.com")).toBeUndefined();
  });
});

describe("inviteMember", () => {
  it("creates a PENDING member record", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({});
    const record = await inviteMember(dynamo, "t", {
      email: "Bob@Acme.com",
      tenantId: "acme-com",
      invitedBy: "admin@acme.com",
    });
    expect(record.email).toBe("bob@acme.com");
    expect(record.status).toBe("PENDING");
    expect(record.role).toBe("member");
  });
});

describe("acceptMembership", () => {
  it("activates a PENDING membership", async () => {
    (dynamo.send as jest.Mock)
      .mockResolvedValueOnce({ Item: memberItem({ status: { S: "PENDING" } }) })
      .mockResolvedValueOnce({});
    const record = await acceptMembership(dynamo, "t", "alice@acme.com");
    expect(record.status).toBe("ACTIVE");
  });

  it("throws when no invitation exists", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: undefined });
    await expect(acceptMembership(dynamo, "t", "alice@acme.com")).rejects.toThrow(/No invitation/);
  });
});

describe("createAdminMembership", () => {
  it("creates an ACTIVE admin membership", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({});
    const record = await createAdminMembership(dynamo, "t", {
      email: "admin@acme.com",
      tenantId: "acme-com",
    });
    expect(record.role).toBe("admin");
    expect(record.status).toBe("ACTIVE");
  });
});

describe("isTenantAdmin", () => {
  it("returns true for an ACTIVE admin of the tenant", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Item: memberItem({ role: { S: "admin" } }),
    });
    expect(await isTenantAdmin(dynamo, "t", "acme-com", "alice@acme.com")).toBe(true);
  });

  it("returns false for a non-admin member", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: memberItem() });
    expect(await isTenantAdmin(dynamo, "t", "acme-com", "alice@acme.com")).toBe(false);
  });

  it("returns false for a member of a different tenant", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Item: memberItem({ tenantId: { S: "other-com" }, role: { S: "admin" } }),
    });
    expect(await isTenantAdmin(dynamo, "t", "acme-com", "alice@acme.com")).toBe(false);
  });
});

describe("listMembers / removeMember", () => {
  it("lists members via the tenantId GSI", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Items: [memberItem(), memberItem({ email: { S: "bob@acme.com" } })],
    });
    const members = await listMembers(dynamo, "t", "acme-com");
    expect(members).toHaveLength(2);
  });

  it("removes a member", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({});
    await removeMember(dynamo, "t", "alice@acme.com");
    expect(dynamo.send).toHaveBeenCalled();
  });
});
