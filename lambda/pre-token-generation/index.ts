import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import {
  domainFromEmail,
  namespacedDepartment,
  tenantOrgWide,
} from "../common/auth";
import { resolveTenantFromMembership } from "../common/membership-store";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { GoogleAdminGroupsFetcher as GoogleAdminGroupsFetcherType } from "./google-admin-groups-fetcher";

export interface GroupsFetcher {
  /** Returns the Google Workspace group emails the user belongs to. */
  fetchGroupsForUser(email: string): Promise<string[]>;
}

/**
 * Resolves a user's tenant (organization) ID from their email. Returns
 * `undefined` when the user has no active membership yet (an unassigned
 * Google user who has not created or joined an organization).
 */
export interface TenantResolver {
  resolveTenantId(email: string): Promise<string | undefined>;
}

/** Fixed tenant for native (non-Google-federated) users, e.g. the dev CLI user. */
export const DEV_TENANT = "dev";

/**
 * Default tenant resolver: the tenant IS the email domain (lowercased).
 * `alice@acme.com` → `acme.com`. Retained for tests and the pre-membership
 * fallback; the production path uses `MembershipTenantResolver`.
 */
export class DomainTenantResolver implements TenantResolver {
  async resolveTenantId(email: string): Promise<string> {
    return domainFromEmail(email);
  }
}

/**
 * Membership-only tenant resolver (multi-user support). Resolves the user's
 * tenant from their ACTIVE membership record. Returns `undefined` when the
 * user has no active membership — the user is unassigned and may create or
 * join an organization. There is no domain fallback: organization membership
 * is the sole source of tenant identity.
 */
export class MembershipTenantResolver implements TenantResolver {
  constructor(
    private readonly dynamo: DynamoDBClient,
    private readonly membershipTableName: string
  ) {}

  async resolveTenantId(email: string): Promise<string | undefined> {
    const member = await resolveTenantFromMembership(this.dynamo, this.membershipTableName, email);
    return member?.tenantId;
  }
}

/**
 * Maps Google Workspace group emails (e.g. "dept-engineering@company.com")
 * to flat department names (spec Section 4.1: "one Workspace group ↔ one
 * department"). The reserved org-wide scope is added later, per-tenant, in
 * buildGroupOverride — not here.
 */
export function mapWorkspaceGroupsToDepartments(workspaceGroupEmails: string[]): string[] {
  const departments = workspaceGroupEmails
    .map((email) => email.split("@")[0])
    .filter((localPart): localPart is string => Boolean(localPart) && localPart.length > 0);
  return Array.from(new Set(departments));
}

/**
 * Native (non-Google-federated) Cognito users have no Google Workspace
 * identity, so the Google Admin SDK fetcher cannot resolve their groups.
 * Their department membership comes from their native Cognito Group
 * memberships, passed in via `groupConfiguration.groupsToOverride`.
 */
export function nativeDepartments(event: PreTokenGenerationV2TriggerEvent): string[] {
  const nativeGroups = event.request.groupConfiguration?.groupsToOverride ?? [];
  return Array.from(new Set(nativeGroups));
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

/**
 * Namespaces a set of flat department names under a tenant and adds the
 * tenant's reserved org-wide scope. `["dept-eng"]` + tenant `acme` →
 * `["acme:dept-eng", "acme:org-wide"]`.
 */
export function scopeDepartmentsToTenant(tenantId: string, departments: string[]): string[] {
  const namespaced = departments.map((d) => namespacedDepartment(tenantId, d));
  return Array.from(new Set([...namespaced, tenantOrgWide(tenantId)]));
}

export async function buildGroupOverride(
  event: PreTokenGenerationV2TriggerEvent,
  groupsFetcher: GroupsFetcher,
  tenantResolver: TenantResolver
): Promise<PreTokenGenerationV2TriggerEvent> {
  const email = event.request.userAttributes.email;
  if (!email) {
    throw new Error("Pre-token-generation event is missing the user's email attribute");
  }

  // Tenant: Google-federated users resolve via the membership resolver;
  // native users get the fixed dev tenant. An unassigned Google user (no
  // active membership) resolves to `undefined` — they authenticate but carry
  // no tenant claim, so they can create/join an org but cannot retrieve data.
  const tenantId = isGoogleFederatedUser(event)
    ? await tenantResolver.resolveTenantId(email)
    : DEV_TENANT;

  // Departments: Google-federated users via the Admin SDK; native users via
  // their native Cognito groups.
  const flatDepartments = isGoogleFederatedUser(event)
    ? mapWorkspaceGroupsToDepartments(await groupsFetcher.fetchGroupsForUser(email))
    : nativeDepartments(event);

  // An unassigned user has no tenant, hence no scoped departments and no
  // tenant claim. They still get a valid token (to call the organizations
  // API), but no retrieval scope.
  const scopedDepartments = tenantId
    ? scopeDepartmentsToTenant(tenantId, flatDepartments)
    : [];

  const claimsToAddOrOverride: Record<string, string> = {
    // API Gateway's HTTP API JWT authorizer drops ARRAY claims (it only
    // forwards string claims), so `cognito:groups` never reaches the
    // upload-handler Lambda. Emit the departments as a comma-separated
    // STRING custom claim too, which survives the gateway.
    "custom:departments": scopedDepartments.join(","),
  };
  if (tenantId) {
    // Emit the tenant as a custom claim so downstream (jwt-auth) can scope
    // retrieval. Custom claims must be prefixed with "custom:".
    claimsToAddOrOverride["custom:tenantId"] = tenantId;
  }

  event.response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride,
      },
      groupOverrideDetails: {
        groupsToOverride: scopedDepartments,
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

  // Tenant resolution is membership-only (multi-user support). When a
  // membership table is configured, use the membership resolver; otherwise
  // fall back to the domain resolver (tests / pre-membership).
  const membershipTable = process.env.TENANT_MEMBERSHIP_TABLE_NAME ?? "";
  const tenantResolver: TenantResolver = membershipTable
    ? new MembershipTenantResolver(new DynamoDBClient({}), membershipTable)
    : new DomainTenantResolver();

  return buildGroupOverride(event, fetcher, tenantResolver);
};
