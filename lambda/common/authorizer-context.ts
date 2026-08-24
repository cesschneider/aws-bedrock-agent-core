import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from "aws-lambda";

/**
 * Reads the normalized authorization context emitted by the dual-issuer
 * Lambda authorizer. The authorizer returns a SIMPLE response whose context
 * is surfaced to the integration as `requestContext.authorizer.lambda.<key>`
 * (string values only).
 *
 * Keys: tenantId, email, departments (comma-separated), userId.
 */

export interface AuthContext {
  tenantId: string;
  email: string;
  departments: string[];
  userId: string;
}

export type AuthorizedEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<Record<string, string>>;

export function authContextFromEvent(event: AuthorizedEvent): AuthContext {
  const ctx = event.requestContext.authorizer.lambda ?? {};
  const tenantId = ctx.tenantId ?? "";
  const email = ctx.email ?? "";
  const userId = ctx.userId ?? "";
  const departments = (ctx.departments ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  if (!tenantId) {
    throw Object.assign(new Error("Missing tenant claim (custom:tenantId)"), { statusCode: 401 });
  }
  return { tenantId, email, departments, userId };
}

/**
 * Like authContextFromEvent but does NOT require a tenantId. Used by the
 * organization-creation flow where a Google-authenticated user may not yet
 * belong to any organization. Email is still required.
 */
export function authContextFromEventOptionalTenant(event: AuthorizedEvent): AuthContext {
  const ctx = event.requestContext.authorizer.lambda ?? {};
  const tenantId = ctx.tenantId ?? "";
  const email = ctx.email ?? "";
  const userId = ctx.userId ?? "";
  const departments = (ctx.departments ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  if (!email || !email.includes("@")) {
    throw Object.assign(new Error("Missing email claim"), { statusCode: 401 });
  }
  return { tenantId, email, departments, userId };
}
