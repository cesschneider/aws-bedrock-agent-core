import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import {
  buildGroupOverride,
  DEV_TENANT,
  DomainTenantResolver,
  GroupsFetcher,
  isGoogleFederatedUser,
  mapWorkspaceGroupsToDepartments,
  nativeDepartments,
  scopeDepartmentsToTenant,
  TenantResolver,
} from "./index";

describe("mapWorkspaceGroupsToDepartments", () => {
  it("strips the domain from Workspace group emails to get department names", () => {
    const result = mapWorkspaceGroupsToDepartments([
      "dept-engineering@company.com",
      "dept-finance@company.com",
    ]);
    expect(result).toEqual(["dept-engineering", "dept-finance"]);
  });

  it("returns an empty list with zero Workspace groups", () => {
    expect(mapWorkspaceGroupsToDepartments([])).toEqual([]);
  });

  it("ignores malformed entries without an @ separator", () => {
    const result = mapWorkspaceGroupsToDepartments(["not-an-email", "dept-eng@company.com"]);
    expect(result).toEqual(["not-an-email", "dept-eng"]);
  });

  it("dedupes duplicate department names", () => {
    const result = mapWorkspaceGroupsToDepartments([
      "dept-eng@company.com",
      "dept-eng@company.com",
    ]);
    expect(result).toEqual(["dept-eng"]);
  });
});

describe("scopeDepartmentsToTenant", () => {
  it("namespaces departments and adds the tenant's org-wide scope", () => {
    const result = scopeDepartmentsToTenant("acme", ["dept-eng"]);
    expect(result).toEqual(["acme:dept-eng", "acme:org-wide"]);
  });

  it("adds only org-wide when there are no departments", () => {
    expect(scopeDepartmentsToTenant("acme", [])).toEqual(["acme:org-wide"]);
  });

  it("dedupes org-wide if a department already matches it", () => {
    const result = scopeDepartmentsToTenant("acme", ["org-wide", "dept-eng"]);
    expect(result.filter((d) => d === "acme:org-wide")).toHaveLength(1);
  });
});

function makeEvent(
  email: string | undefined,
  opts: { identities?: string; nativeGroups?: string[] } = {}
): PreTokenGenerationV2TriggerEvent {
  return {
    version: "2",
    triggerSource: "TokenGeneration_HostedAuth",
    request: {
      userAttributes: email
        ? { email, ...(opts.identities ? { identities: opts.identities } : {}) }
        : {},
      groupConfiguration: {
        groupsToOverride: opts.nativeGroups ?? [],
        iamRolesToOverride: [],
        preferredRole: undefined,
      },
    },
    response: {},
  } as unknown as PreTokenGenerationV2TriggerEvent;
}

const GOOGLE_IDENTITIES =
  '[{"userId":"12345","providerName":"Google","providerType":"Google","issuer":"https://accounts.google.com"}]';

const resolver: TenantResolver = new DomainTenantResolver();

describe("isGoogleFederatedUser / nativeDepartments", () => {
  it("recognizes a Google-federated user by the identities attribute", () => {
    expect(isGoogleFederatedUser(makeEvent("a@company.com", { identities: GOOGLE_IDENTITIES }))).toBe(true);
  });

  it("treats a user without identities as native (non-Google)", () => {
    expect(isGoogleFederatedUser(makeEvent("a@company.com"))).toBe(false);
  });

  it("passes native Cognito groups through for native users", () => {
    const event = makeEvent("dev@company.com", { nativeGroups: ["dept-engineering"] });
    expect(nativeDepartments(event)).toEqual(["dept-engineering"]);
  });

  it("returns an empty list for a native user with no group memberships", () => {
    expect(nativeDepartments(makeEvent("dev@company.com"))).toEqual([]);
  });
});

describe("buildGroupOverride", () => {
  it("sets tenant claim + namespaced groups for Google-federated users", async () => {
    const fetcher: GroupsFetcher = {
      fetchGroupsForUser: jest.fn().mockResolvedValue(["dept-engineering@company.com"]),
    };
    const event = makeEvent("alice@acme.com", { identities: GOOGLE_IDENTITIES });

    const result = await buildGroupOverride(event, fetcher, resolver);

    const override = result.response.claimsAndScopeOverrideDetails;
    expect(override?.idTokenGeneration?.claimsToAddOrOverride?.["custom:tenantId"]).toBe("acme.com");
    expect(override?.idTokenGeneration?.claimsToAddOrOverride?.["custom:departments"]).toBe(
      "acme.com:dept-engineering,acme.com:org-wide"
    );
    expect(override?.groupOverrideDetails?.groupsToOverride).toEqual([
      "acme.com:dept-engineering",
      "acme.com:org-wide",
    ]);
    expect(fetcher.fetchGroupsForUser).toHaveBeenCalledWith("alice@acme.com");
  });

  it("uses the fixed dev tenant for native users and skips the Google fetcher", async () => {
    const fetcher: GroupsFetcher = { fetchGroupsForUser: jest.fn() };
    const event = makeEvent("dev@company.com", { nativeGroups: ["dept-engineering"] });

    const result = await buildGroupOverride(event, fetcher, resolver);

    const override = result.response.claimsAndScopeOverrideDetails;
    expect(override?.idTokenGeneration?.claimsToAddOrOverride?.["custom:tenantId"]).toBe(DEV_TENANT);
    expect(override?.groupOverrideDetails?.groupsToOverride).toEqual([
      "dev:dept-engineering",
      "dev:org-wide",
    ]);
    expect(fetcher.fetchGroupsForUser).not.toHaveBeenCalled();
  });

  it("throws when the event has no email attribute", async () => {
    const fetcher: GroupsFetcher = { fetchGroupsForUser: jest.fn() };
    const event = makeEvent(undefined);

    await expect(buildGroupOverride(event, fetcher, resolver)).rejects.toThrow(/email/i);
    expect(fetcher.fetchGroupsForUser).not.toHaveBeenCalled();
  });

  it("propagates fetcher errors for Google-federated users rather than silently granting no access", async () => {
    const fetcher: GroupsFetcher = {
      fetchGroupsForUser: jest.fn().mockRejectedValue(new Error("Google Admin API unavailable")),
    };
    const event = makeEvent("alice@acme.com", { identities: GOOGLE_IDENTITIES });

    await expect(buildGroupOverride(event, fetcher, resolver)).rejects.toThrow(
      "Google Admin API unavailable"
    );
  });

  it("propagates tenant-resolver errors (fail closed on unknown domain)", async () => {
    const failingResolver: TenantResolver = {
      resolveTenantId: jest.fn().mockRejectedValue(new Error("Unknown domain")),
    };
    const fetcher: GroupsFetcher = { fetchGroupsForUser: jest.fn() };
    const event = makeEvent("alice@unknown.com", { identities: GOOGLE_IDENTITIES });

    await expect(buildGroupOverride(event, fetcher, failingResolver)).rejects.toThrow(
      "Unknown domain"
    );
  });

  it("emits no tenant claim for an unassigned Google user (no active membership)", async () => {
    const unassignedResolver: TenantResolver = {
      resolveTenantId: jest.fn().mockResolvedValue(undefined),
    };
    const fetcher: GroupsFetcher = { fetchGroupsForUser: jest.fn().mockResolvedValue([]) };
    const event = makeEvent("new@acme.com", { identities: GOOGLE_IDENTITIES });

    const result = await buildGroupOverride(event, fetcher, unassignedResolver);

    const override = result.response.claimsAndScopeOverrideDetails;
    expect(override?.idTokenGeneration?.claimsToAddOrOverride?.["custom:tenantId"]).toBeUndefined();
    expect(override?.idTokenGeneration?.claimsToAddOrOverride?.["custom:departments"]).toBe("");
    expect(override?.groupOverrideDetails?.groupsToOverride).toEqual([]);
  });
});
