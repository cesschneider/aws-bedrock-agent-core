import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { COMPANY_WIDE } from "../common/auth";
import {
  buildGroupOverride,
  GroupsFetcher,
  isGoogleFederatedUser,
  mapWorkspaceGroupsToDepartments,
  nativeDepartments,
} from "./index";

describe("mapWorkspaceGroupsToDepartments", () => {
  it("strips the domain from Workspace group emails to get department names", () => {
    const result = mapWorkspaceGroupsToDepartments([
      "dept-engineering@company.com",
      "dept-finance@company.com",
    ]);
    expect(result).toEqual(expect.arrayContaining(["dept-engineering", "dept-finance", COMPANY_WIDE]));
    expect(result).toHaveLength(3);
  });

  it("always includes company-wide even with zero Workspace groups", () => {
    expect(mapWorkspaceGroupsToDepartments([])).toEqual([COMPANY_WIDE]);
  });

  it("ignores malformed entries without an @ separator", () => {
    const result = mapWorkspaceGroupsToDepartments(["not-an-email", "dept-eng@company.com"]);
    expect(result).toEqual(expect.arrayContaining(["not-an-email", "dept-eng", COMPANY_WIDE]));
  });

  it("does not duplicate company-wide if a Workspace group happens to share the name", () => {
    const result = mapWorkspaceGroupsToDepartments([`${COMPANY_WIDE}@company.com`, "dept-eng@company.com"]);
    expect(result.filter((d) => d === COMPANY_WIDE)).toHaveLength(1);
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

describe("isGoogleFederatedUser / nativeDepartments", () => {
  it("recognizes a Google-federated user by the identities attribute", () => {
    expect(isGoogleFederatedUser(makeEvent("a@company.com", { identities: GOOGLE_IDENTITIES }))).toBe(true);
  });

  it("treats a user without identities as native (non-Google)", () => {
    expect(isGoogleFederatedUser(makeEvent("a@company.com"))).toBe(false);
  });

  it("passes native Cognito groups through plus company-wide for native users", () => {
    const event = makeEvent("dev@company.com", { nativeGroups: ["dept-engineering"] });
    expect(nativeDepartments(event)).toEqual(expect.arrayContaining(["dept-engineering", COMPANY_WIDE]));
  });

  it("grants only company-wide to a native user with no group memberships", () => {
    expect(nativeDepartments(makeEvent("dev@company.com"))).toEqual([COMPANY_WIDE]);
  });
});

describe("buildGroupOverride", () => {
  it("sets groupsToOverride from Google Workspace groups for federated users", async () => {
    const fetcher: GroupsFetcher = {
      fetchGroupsForUser: jest.fn().mockResolvedValue(["dept-engineering@company.com"]),
    };
    const event = makeEvent("alice@company.com", { identities: GOOGLE_IDENTITIES });

    const result = await buildGroupOverride(event, fetcher);

    const override = result.response.claimsAndScopeOverrideDetails;
    expect(override?.groupOverrideDetails?.groupsToOverride).toEqual(
      expect.arrayContaining(["dept-engineering", COMPANY_WIDE])
    );
    expect(fetcher.fetchGroupsForUser).toHaveBeenCalledWith("alice@company.com");
  });

  it("uses native Cognito groups and skips the Google fetcher for native users", async () => {
    const fetcher: GroupsFetcher = { fetchGroupsForUser: jest.fn() };
    const event = makeEvent("dev@company.com", { nativeGroups: ["dept-engineering"] });

    const result = await buildGroupOverride(event, fetcher);

    const override = result.response.claimsAndScopeOverrideDetails;
    expect(override?.groupOverrideDetails?.groupsToOverride).toEqual(
      expect.arrayContaining(["dept-engineering", COMPANY_WIDE])
    );
    expect(fetcher.fetchGroupsForUser).not.toHaveBeenCalled();
  });

  it("throws when the event has no email attribute", async () => {
    const fetcher: GroupsFetcher = { fetchGroupsForUser: jest.fn() };
    const event = makeEvent(undefined);

    await expect(buildGroupOverride(event, fetcher)).rejects.toThrow(/email/i);
    expect(fetcher.fetchGroupsForUser).not.toHaveBeenCalled();
  });

  it("propagates fetcher errors for Google-federated users rather than silently granting no access", async () => {
    const fetcher: GroupsFetcher = {
      fetchGroupsForUser: jest.fn().mockRejectedValue(new Error("Google Admin API unavailable")),
    };
    const event = makeEvent("alice@company.com", { identities: GOOGLE_IDENTITIES });

    await expect(buildGroupOverride(event, fetcher)).rejects.toThrow("Google Admin API unavailable");
  });
});

