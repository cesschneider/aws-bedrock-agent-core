import { randomBytes } from "crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  activateTenant,
  createTenant,
  TenantRegistryError,
} from "../common/tenant-registry";
import { domainFromEmail } from "../common/auth";

/**
 * Self-service tenant provisioning (multi-tenant design Phase B2).
 *
 * Two endpoints:
 *   POST /signup  — create a PENDING tenant, email a verification link to
 *                   the admin email (on the claimed domain).
 *   POST /confirm — activate the tenant after the admin confirms the link.
 *
 * Domain verification is admin-email confirmation (resolved decision #4):
 * the admin email must be on the claimed domain, and the domain→tenant
 * mapping is activated only after the admin clicks the emailed link.
 */

const dynamo = new DynamoDBClient({});
const tableName = process.env.TENANT_REGISTRY_TABLE_NAME ?? "";

interface SignupBody {
  name: string;
  adminEmail: string;
  domain: string;
}

interface ConfirmBody {
  domain: string;
  token: string;
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function parseBody<T>(raw: string | undefined): T {
  if (!raw) throw new TenantRegistryError("Request body is required");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new TenantRegistryError("Request body must be valid JSON");
  }
}

/**
 * Sends the verification email. In production this uses SES; the exact
 * transport is wired by the CDK construct. This is a seam for testing.
 */
export type EmailSender = (to: string, subject: string, body: string) => Promise<void>;

export async function handleSignup(
  event: APIGatewayProxyEventV2,
  sendEmail: EmailSender
): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const { name, adminEmail, domain } = parseBody<SignupBody>(event.body);

    if (!name || typeof name !== "string") {
      return json(400, { error: "name is required" });
    }
    if (!adminEmail || typeof adminEmail !== "string") {
      return json(400, { error: "adminEmail is required" });
    }
    if (!domain || typeof domain !== "string") {
      return json(400, { error: "domain is required" });
    }

    // Admin email must be on the claimed domain (resolved decision #4).
    const adminDomain = domainFromEmail(adminEmail);
    if (adminDomain !== domain.toLowerCase()) {
      return json(400, { error: "adminEmail must be on the claimed domain" });
    }

    const token = randomBytes(32).toString("hex");
    const record = await createTenant(dynamo, tableName, {
      domain,
      name,
      adminEmail,
      verificationToken: token,
    });

    const confirmUrl = `${process.env.CONFIRM_BASE_URL ?? ""}/confirm?domain=${encodeURIComponent(
      record.domain
    )}&token=${token}`;
    await sendEmail(
      adminEmail,
      "Confirm your organization",
      `Click to activate your tenant: ${confirmUrl}`
    );

    return json(201, { domain: record.domain, tenantId: record.tenantId, status: record.status });
  } catch (err) {
    if (err instanceof TenantRegistryError) {
      return json(400, { error: err.message });
    }
    // Duplicate domain (ConditionExpression failure) → 409.
    if ((err as Error).name === "ConditionalCheckFailedException") {
      return json(409, { error: "Domain already registered" });
    }
    console.error("Signup error:", err);
    return json(500, { error: "Internal server error" });
  }
}

export async function handleConfirm(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const { domain, token } = parseBody<ConfirmBody>(event.body);
    if (!domain || !token) {
      return json(400, { error: "domain and token are required" });
    }

    const record = await activateTenant(dynamo, tableName, domain, token);
    return json(200, { domain: record.domain, tenantId: record.tenantId, status: record.status });
  } catch (err) {
    if (err instanceof TenantRegistryError) {
      return json(400, { error: err.message });
    }
    console.error("Confirm error:", err);
    return json(500, { error: "Internal server error" });
  }
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!tableName) {
    return json(500, { error: "TENANT_REGISTRY_TABLE_NAME is not set" });
  }

  const route = event.rawPath ?? event.requestContext?.http?.path ?? "";
  if (route.endsWith("/signup")) {
    // Placeholder email sender — the CDK construct injects a real SES sender
    // via a Lambda layer or environment; for now, log instead of send.
    const noopSender: EmailSender = async (to, subject) => {
      console.log(`[provisioning] would email ${to}: ${subject}`);
    };
    return handleSignup(event, noopSender);
  }
  if (route.endsWith("/confirm")) {
    return handleConfirm(event);
  }
  return json(404, { error: "Not found" });
};
