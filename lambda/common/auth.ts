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

/** Extracts the email domain (lowercased), e.g. `alice@acme.com` → `acme`. */
export function domainFromEmail(email: string): string {
  const idx = email.lastIndexOf("@");
  if (idx <= 0 || idx === email.length - 1) {
    throw new Error(`Cannot derive domain from email "${email}"`);
  }
  return email.slice(idx + 1).toLowerCase();
}

/**
 * Extracts department claims from a verified JWT's request-context claims.
 *
 * API Gateway's HTTP API JWT authorizer drops ARRAY claims (it only forwards
 * string claims to the integration), so `cognito:groups` never reaches the
 * Lambda. pre-token-generation therefore ALSO emits the tenant-namespaced
 * departments as a comma-separated STRING custom claim (`custom:departments`),
 * which survives the gateway. This helper reads that string claim.
 */
export function parseDepartmentClaims(claims: Record<string, string> | undefined): string[] {
  const raw = claims?.["custom:departments"] ?? "";
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

export function userCanAccessDepartment(userDepartments: string[], targetDepartment: string): boolean {
  return userDepartments.includes(targetDepartment);
}

