import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

/**
 * Shared organization access (name-based org creation).
 *
 * Replaces the domain→tenant registry. An organization is identified by a
 * `tenantId` slug derived from its chosen name. The first user (the Google
 * account that creates the org) becomes its admin via a membership record.
 *
 * There is no email-verification token and no domain action: the org is
 * created directly, together with its admin user.
 */

export interface OrganizationRecord {
  tenantId: string;
  name: string;
  adminEmail: string;
  status: "ACTIVE";
  createdAt: string;
}

export class OrganizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationError";
  }
}

/**
 * Derives a canonical tenantId slug from a display name. Lowercased,
 * non-alphanumeric runs collapsed to a single dash, trimmed, capped at 64.
 * `"Acme Corporation"` → `"acme-corporation"`.
 */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** A slug is valid when it is non-empty and contains only [a-z0-9-]. */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && /^[a-z0-9-]+$/.test(slug);
}

function fromItem(item: Record<string, AttributeValue> | undefined): OrganizationRecord | undefined {
  if (!item) return undefined;
  return {
    tenantId: item.tenantId.S as string,
    name: item.name.S as string,
    adminEmail: item.adminEmail.S as string,
    status: item.status.S as "ACTIVE",
    createdAt: item.createdAt.S as string,
  };
}

export async function getOrganization(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string
): Promise<OrganizationRecord | undefined> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { tenantId: { S: tenantId } },
    })
  );
  return fromItem(result.Item);
}

/** Whether a name (via its slug) is available for a new organization. */
export async function isNameAvailable(
  dynamo: DynamoDBClient,
  tableName: string,
  name: string
): Promise<boolean> {
  const slug = slugFromName(name);
  if (!isValidSlug(slug)) return false;
  const existing = await getOrganization(dynamo, tableName, slug);
  return existing === undefined;
}

/**
 * Creates an organization. Fails (ConditionalCheckFailedException) when the
 * slug is already taken.
 */
export async function createOrganization(
  dynamo: DynamoDBClient,
  tableName: string,
  input: { name: string; adminEmail: string }
): Promise<OrganizationRecord> {
  const tenantId = slugFromName(input.name);
  if (!isValidSlug(tenantId)) {
    throw new OrganizationError(`Invalid organization name "${input.name}"`);
  }

  const record: OrganizationRecord = {
    tenantId,
    name: input.name.trim(),
    adminEmail: input.adminEmail.toLowerCase(),
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        tenantId: { S: record.tenantId },
        name: { S: record.name },
        adminEmail: { S: record.adminEmail },
        status: { S: record.status },
        createdAt: { S: record.createdAt },
      },
      ConditionExpression: "attribute_not_exists(tenantId)",
    })
  );

  return record;
}
