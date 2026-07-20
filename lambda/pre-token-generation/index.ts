import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { COMPANY_WIDE } from "../common/auth";
import type { GoogleAdminGroupsFetcher as GoogleAdminGroupsFetcherType } from "./google-admin-groups-fetcher";

export interface GroupsFetcher {
  /** Returns the Google Workspace group emails the user belongs to. */
  fetchGroupsForUser(email: string): Promise<string[]>;
}

/**
 * Maps Google Workspace group emails (e.g. "dept-engineering@company.com")
 * to department names (spec Section 4.1: "one Workspace group ↔ one
 * department"), always including the reserved company-wide department.
 */
export function mapWorkspaceGroupsToDepartments(workspaceGroupEmails: string[]): string[] {
  const departments = workspaceGroupEmails
    .map((email) => email.split("@")[0])
    .filter((localPart): localPart is string => Boolean(localPart) && localPart.length > 0);
  return Array.from(new Set([...departments, COMPANY_WIDE]));
}

/**
 * Native (non-Google-federated) Cognito users have no Google Workspace
 * identity, so the Google Admin SDK fetcher cannot resolve their groups —
 * and until the Workspace service account is configured (see
 * docs/deployment-setup.md) that fetcher fails at runtime. For these users
 * (used by the dev CLI's USER_PASSWORD_AUTH login), department membership
 * comes from their native Cognito Group memberships instead, which Cognito
 * passes in via `groupConfiguration.groupsToOverride`. We pass those through
 * unchanged (plus the reserved company-wide department).
 */
export function nativeDepartments(event: PreTokenGenerationV2TriggerEvent): string[] {
  const nativeGroups = event.request.groupConfiguration?.groupsToOverride ?? [];
  return Array.from(new Set([...nativeGroups, COMPANY_WIDE]));
}

/**
 * A user is Google-federated when Cognito records an `identities` attribute
 * referencing the Google provider. Native (admin-created) users have no such
 * attribute. The value is a JSON array string, e.g.
 * `[{"providerName":"Google","providerType":"Google","issuer":"..."}]`.
 */
export function isGoogleFederatedUser(event: PreTokenGenerationV2TriggerEvent): boolean {
  const identities = event.request.userAttributes.identities;
  return typeof identities === "string" && identities.includes("Google");
}

export async function buildGroupOverride(
  event: PreTokenGenerationV2TriggerEvent,
  groupsFetcher: GroupsFetcher
): Promise<PreTokenGenerationV2TriggerEvent> {
  const email = event.request.userAttributes.email;
  if (!email) {
    throw new Error("Pre-token-generation event is missing the user's email attribute");
  }

  // Native users: skip the Google Admin SDK (which has no identity to look up
  // and fails at runtime until the Workspace service account is configured).
  // Use their native Cognito groups as the department claim instead.
  const departments = isGoogleFederatedUser(event)
    ? mapWorkspaceGroupsToDepartments(await groupsFetcher.fetchGroupsForUser(email))
    : nativeDepartments(event);

  event.response = {
    claimsAndScopeOverrideDetails: {
      groupOverrideDetails: {
        groupsToOverride: departments,
      },
    },
  };

  return event;
}

// Real Google Admin SDK wiring — requires a Workspace service account with
// domain-wide delegation for the Admin SDK Directory API's
// admin.directory.group.readonly scope. This is a one-time manual setup
// step in the Google Workspace Admin console (not something CDK/IAM can
// automate), documented in docs/deployment-setup.md follow-up. Until that
// setup exists, this fetcher will fail at runtime — it is not exercised by
// unit tests, which cover buildGroupOverride/mapWorkspaceGroupsToDepartments
// against fake fetchers instead.
//
// Cognito enforces its own short timeout on auth Lambda triggers, well under
// this function's configured 10s. The `googleapis` package is large enough
// that importing it (and constructing the JWT client) at cold start blew
// past that ceiling on EVERY invocation — including native-user logins
// (e.g. the dev CLI) that never call this fetcher at all. Load it lazily,
// only when a Google-federated user actually needs it.
let cachedFetcher: GoogleAdminGroupsFetcherType | undefined;
async function getGoogleAdminGroupsFetcher(): Promise<GoogleAdminGroupsFetcherType> {
  if (!cachedFetcher) {
    const { GoogleAdminGroupsFetcher } = await import("./google-admin-groups-fetcher");
    cachedFetcher = new GoogleAdminGroupsFetcher();
  }
  return cachedFetcher;
}

export const handler = async (
  event: PreTokenGenerationV2TriggerEvent
): Promise<PreTokenGenerationV2TriggerEvent> => {
  const fetcher: GroupsFetcher = {
    fetchGroupsForUser: async (email) => (await getGoogleAdminGroupsFetcher()).fetchGroupsForUser(email),
  };
  return buildGroupOverride(event, fetcher);
};
