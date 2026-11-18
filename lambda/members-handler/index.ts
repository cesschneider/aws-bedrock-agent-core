import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  acceptMembership,
  inviteMember,
  isTenantAdmin,
  listMembers,
  removeMember,
  updateMemberDepartments,
  getMember,
  MembershipError,
} from "../common/membership-store";
import { authContextFromEvent, authContextFromEventOptionalTenant, type AuthorizedEvent } from "../common/authorizer-context";

/**
 * Per-tenant member management API (multi-user support).
 *
 *   GET    /members                         — list members (admin)
 *   POST   /members/invite                  — invite a user by email (admin)
 *   POST   /members/accept                  — accept the caller's own invitation
 *   PUT    /members/{email}/departments     — update member's departments (admin)
 *   DELETE /members/{email}                 — remove a member (admin)
 *
 * The first user of a tenant (the provisioning admin) is created ACTIVE +
 * admin at tenant activation time. Admins invite additional users; invited
 * users accept via the link and become ACTIVE members with access to the
 * tenant's data.
 */

const dynamo = new DynamoDBClient({});
const tableName = process.env.TENANT_MEMBERSHIP_TABLE_NAME ?? "";
const envName = process.env.ENV_NAME ?? "";

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

interface AuthContext {
  tenantId: string;
  email: string;
}

function authFromEvent(event: AuthorizedEvent): AuthContext {
  const auth = authContextFromEvent(event);
  const email = auth.email;
  if (!email) {
    throw Object.assign(new Error("Missing email claim"), { statusCode: 401 });
  }
  return { tenantId: auth.tenantId, email: email.toLowerCase() };
}

/**
 * Admin check. The `dev` tenant is a native-user test tenant (no registry
 * record) that only exists in non-prd environments; any authenticated member
 * of `dev` is treated as admin so the admin UI can be exercised end-to-end.
 */
async function requireAdmin(auth: AuthContext): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  if (auth.tenantId === "dev" && envName !== "prd") return undefined;
  const isAdmin = await isTenantAdmin(dynamo, tableName, auth.tenantId, auth.email);
  if (!isAdmin) {
    return json(403, { error: "Only the tenant admin can manage members" });
  }
  return undefined;
}

async function handleList(auth: AuthContext): Promise<APIGatewayProxyStructuredResultV2> {
  const denied = await requireAdmin(auth);
  if (denied) return denied;
  const members = await listMembers(dynamo, tableName, auth.tenantId);
  return json(200, {
    members: members.map((m) => ({
      email: m.email,
      role: m.role,
      status: m.status,
      departments: m.departments,
      invitedBy: m.invitedBy,
      invitedAt: m.invitedAt,
      acceptedAt: m.acceptedAt,
    })),
  });
}

async function handleInvite(auth: AuthContext, body: { email?: string }): Promise<APIGatewayProxyStructuredResultV2> {
  const denied = await requireAdmin(auth);
  if (denied) return denied;

  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return json(400, { error: "A valid email is required" });
  }

  try {
    const record = await inviteMember(dynamo, tableName, {
      email,
      tenantId: auth.tenantId,
      invitedBy: auth.email,
    });
    return json(201, {
      email: record.email,
      tenantId: record.tenantId,
      role: record.role,
      status: record.status,
    });
  } catch (err) {
    if ((err as Error).name === "ConditionalCheckFailedException") {
      return json(409, { error: "This email is already a member of an organization" });
    }
    throw err;
  }
}

async function handleAccept(auth: AuthContext): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const record = await acceptMembership(dynamo, tableName, auth.email);
    return json(200, {
      email: record.email,
      tenantId: record.tenantId,
      role: record.role,
      status: record.status,
    });
  } catch (err) {
    if (err instanceof MembershipError) {
      return json(404, { error: err.message });
    }
    throw err;
  }
}

async function handleUpdateDepartments(
  auth: AuthContext,
  targetEmail: string,
  body: { departments?: string[] }
): Promise<APIGatewayProxyStructuredResultV2> {
  const denied = await requireAdmin(auth);
  if (denied) return denied;

  const email = targetEmail.toLowerCase();
  const departments = (body.departments ?? []).map((d) => d.trim()).filter((d) => d.length > 0);

  // Verify the target is a member of the admin's tenant
  const member = await getMember(dynamo, tableName, email);
  if (!member || member.tenantId !== auth.tenantId) {
    return json(404, { error: "Member not found in your organization" });
  }

  const updated = await updateMemberDepartments(dynamo, tableName, email, departments);
  return json(200, {
    email: updated.email,
    tenantId: updated.tenantId,
    role: updated.role,
    status: updated.status,
    departments: updated.departments,
  });
}

async function handleRemove(auth: AuthContext, targetEmail: string): Promise<APIGatewayProxyStructuredResultV2> {
  const denied = await requireAdmin(auth);
  if (denied) return denied;

  const email = targetEmail.toLowerCase();
  // An admin cannot remove themselves (prevents orphaning the tenant).
  if (email === auth.email) {
    return json(400, { error: "An admin cannot remove themselves" });
  }

  await removeMember(dynamo, tableName, email);
  return json(200, { deleted: true, email });
}

export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!tableName) {
    return json(500, { error: "TENANT_MEMBERSHIP_TABLE_NAME is required" });
  }

  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath ?? event.requestContext.http.path ?? "";
    const segments = path.split("/").filter(Boolean); // e.g. ["members", "invite"]

    // POST /members/accept — uses optional-tenant auth (invitee has PENDING
    // membership, no active tenant yet). All other routes require a tenant.
    if (method === "POST" && segments.length === 2 && segments[0] === "members" && segments[1] === "accept") {
      const optAuth = authContextFromEventOptionalTenant(event);
      const email = optAuth.email.toLowerCase();
      return await handleAccept({ tenantId: optAuth.tenantId, email });
    }

    const auth = authFromEvent(event);

    // GET /members
    if (method === "GET" && segments.length === 1 && segments[0] === "members") {
      return await handleList(auth);
    }

    // POST /members/invite
    if (method === "POST" && segments.length === 2 && segments[0] === "members" && segments[1] === "invite") {
      const body = JSON.parse(event.body ?? "{}") as { email?: string };
      return await handleInvite(auth, body);
    }

    // PUT /members/{email}/departments — update member's department assignments (admin)
    if (method === "PUT" && segments.length === 3 && segments[0] === "members" && segments[2] === "departments") {
      const body = JSON.parse(event.body ?? "{}") as { departments?: string[] };
      return await handleUpdateDepartments(auth, decodeURIComponent(segments[1]), body);
    }

    // DELETE /members/{email}
    if (method === "DELETE" && segments.length === 2 && segments[0] === "members") {
      return await handleRemove(auth, decodeURIComponent(segments[1]));
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("Members handler error:", err);
    const e = err as { statusCode?: number; message?: string };
    return json(e.statusCode ?? 500, { error: e.message ?? "Internal server error" });
  }
};
