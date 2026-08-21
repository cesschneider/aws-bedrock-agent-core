import { randomBytes } from "crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import {
  activateTenant,
  createTenant,
  TenantRegistryError,
} from "../common/tenant-registry";
import { createAdminMembership } from "../common/membership-store";
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
const membershipTableName = process.env.TENANT_MEMBERSHIP_TABLE_NAME ?? "";

// SES is optional: when FROM_EMAIL is configured the verification link is
// emailed; otherwise the sender logs the link (dev fallback) so the flow
// still works end-to-end for testing.
const ses = new SESClient({});
const fromEmail = process.env.FROM_EMAIL ?? "";

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
  sendEmail: EmailSender,
  baseUrl?: string
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

    const confirmUrl = `${baseUrl ?? process.env.CONFIRM_BASE_URL ?? ""}/confirm?domain=${encodeURIComponent(
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

    // The first user of the tenant is the provisioning admin. Create their
    // ACTIVE admin membership so they can log in and invite others. Best
    // effort: if the membership table isn't configured (or the admin already
    // has a membership), the tenant is still activated.
    if (membershipTableName) {
      try {
        await createAdminMembership(dynamo, membershipTableName, {
          email: record.adminEmail,
          tenantId: record.tenantId,
        });
      } catch (err) {
        if ((err as Error).name !== "ConditionalCheckFailedException") {
          console.error("Failed to create admin membership:", err);
        }
      }
    }

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
    // Derive the confirm base URL from the request itself (the API's own
    // domain) so the Lambda doesn't need its own endpoint injected — avoids a
    // CloudFormation circular dependency between the Lambda and its HTTP API.
    const domainName = event.requestContext?.domainName;
    const baseUrl = domainName ? `https://${domainName}` : undefined;
    const sender: EmailSender = fromEmail
      ? async (to, subject, body) => {
          await ses.send(
            new SendEmailCommand({
              Source: fromEmail,
              Destination: { ToAddresses: [to] },
              Message: {
                Subject: { Data: subject },
                Body: { Text: { Data: body } },
              },
            })
          );
        }
      : async (to, subject, body) => {
          console.log(`[provisioning] SES not configured — would email ${to}: ${subject}\n${body}`);
        };
    return handleSignup(event, sender, baseUrl);
  }
  if (route.endsWith("/confirm")) {
    return handleConfirm(event);
  }
  return json(404, { error: "Not found" });
};
