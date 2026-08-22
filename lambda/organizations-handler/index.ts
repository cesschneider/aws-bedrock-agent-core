import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  createOrganization,
  isNameAvailable,
  slugFromName,
  isValidSlug,
  OrganizationError,
} from "../common/organization-store";
import { createAdminMembership, getMember } from "../common/membership-store";
import { authContextFromEvent, type AuthorizedEvent } from "../common/authorizer-context";

/**
 * Name-based organization creation (Google-account flow).
 *
 *   GET  /organizations/check-name?name=…  — whether a name is available
 *   POST /organizations                     — create an org + admin membership
 *
 * The caller is a Google-federated user (their email is the JWT `email`
 * claim). Creating an org makes that user its admin. A user may belong to
 * exactly one organization, so creation fails if they are already a member.
 */

const dynamo = new DynamoDBClient({});
const orgTable = process.env.ORGANIZATION_TABLE_NAME ?? "";
const membershipTable = process.env.TENANT_MEMBERSHIP_TABLE_NAME ?? "";

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function emailFromEvent(event: AuthorizedEvent): string {
  const auth = authContextFromEvent(event);
  const email = auth.email;
  if (!email || !email.includes("@")) {
    throw Object.assign(new Error("Missing email claim"), { statusCode: 401 });
  }
  return email.toLowerCase();
}

async function handleCheckName(name: string): Promise<APIGatewayProxyStructuredResultV2> {
  const slug = slugFromName(name);
  if (!isValidSlug(slug)) {
    return json(200, { name, slug, available: false, reason: "invalid-name" });
  }
  const available = await isNameAvailable(dynamo, orgTable, name);
  return json(200, { name, slug, available });
}

async function handleCreate(
  email: string,
  body: { name?: string }
): Promise<APIGatewayProxyStructuredResultV2> {
  const name = body.name?.trim();
  if (!name) {
    return json(400, { error: "name is required" });
  }
  const slug = slugFromName(name);
  if (!isValidSlug(slug)) {
    return json(400, {
      error: "Invalid organization name: use letters, numbers, spaces, or hyphens",
    });
  }

  // A user belongs to exactly one organization.
  const existingMembership = await getMember(dynamo, membershipTable, email);
  if (existingMembership) {
    return json(409, { error: "You already belong to an organization" });
  }

  try {
    const org = await createOrganization(dynamo, orgTable, { name, adminEmail: email });
    await createAdminMembership(dynamo, membershipTable, {
      email,
      tenantId: org.tenantId,
    });
    return json(201, {
      tenantId: org.tenantId,
      name: org.name,
      adminEmail: org.adminEmail,
      status: org.status,
    });
  } catch (err) {
    if ((err as Error).name === "ConditionalCheckFailedException") {
      return json(409, { error: "This organization name is already taken" });
    }
    if (err instanceof OrganizationError) {
      return json(400, { error: err.message });
    }
    throw err;
  }
}

export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!orgTable || !membershipTable) {
    return json(500, { error: "ORGANIZATION_TABLE_NAME and TENANT_MEMBERSHIP_TABLE_NAME are required" });
  }

  try {
    const email = emailFromEvent(event);
    const method = event.requestContext.http.method;
    const path = event.rawPath ?? event.requestContext.http.path ?? "";
    const segments = path.split("/").filter(Boolean); // e.g. ["organizations"]

    // GET /organizations/check-name?name=…
    if (method === "GET" && segments.length === 2 && segments[0] === "organizations" && segments[1] === "check-name") {
      const name = event.queryStringParameters?.name ?? "";
      return await handleCheckName(name);
    }

    // POST /organizations
    if (method === "POST" && segments.length === 1 && segments[0] === "organizations") {
      const body = JSON.parse(event.body ?? "{}") as { name?: string };
      return await handleCreate(email, body);
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("Organizations handler error:", err);
    const e = err as { statusCode?: number; message?: string };
    return json(e.statusCode ?? 500, { error: e.message ?? "Internal server error" });
  }
};
