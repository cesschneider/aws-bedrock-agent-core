/**
 * Shared helpers for extracting department claims from a verified JWT.
 *
 * Per spec (specs/rag-knowledge-agent-spec.md, Section 4.1): department
 * membership comes from Google Workspace groups, mapped into Cognito group
 * claims at federation time. Every authenticated user implicitly has access
 * to the reserved "company-wide" department regardless of group membership.
 */

export const COMPANY_WIDE = "company-wide";

/**
 * Per-tenant reserved scope (multi-tenant design §3). Replaces the single
 * global `company-wide` — every user of a tenant can query that tenant's
 * org-level content. Namespaced as `{tenantId}:org-wide`.
 */
export const ORG_WIDE = "org-wide";

/** Returns the tenant-namespaced org-wide scope, e.g. `acme:org-wide`. */
export function tenantOrgWide(tenantId: string): string {
  return `${tenantId}:${ORG_WIDE}`;
}

/** Returns a tenant-namespaced department, e.g. `acme:dept-engineering`. */
export function namespacedDepartment(tenantId: string, department: string): string {
  return `${tenantId}:${department}`;
}

/**
 * The `cognito:groups` claim on an HTTP API JWT authorizer arrives as a
 * comma-separated string (API Gateway does not preserve JSON array shape
 * for custom/group claims), e.g. "dept-engineering,dept-finance".
 */
export function parseDepartmentClaims(claims: Record<string, string> | undefined): string[] {
  const raw = claims?.["cognito:groups"] ?? "";
  const groups = raw
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);

  // Every authenticated user gets company-wide access regardless of group
  // membership — never duplicate it if a group happens to be named that.
  return Array.from(new Set([...groups, COMPANY_WIDE]));
}

export function userCanAccessDepartment(userDepartments: string[], targetDepartment: string): boolean {
  return userDepartments.includes(targetDepartment);
}

