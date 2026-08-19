import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

/**
 * Shared tenant-registry access (multi-tenant design §4.1, Phase B2).
 *
 * The registry maps an email `domain` (lowercased) to a canonical `tenantId`
 * plus metadata. `pre-token-generation` resolves a user's domain against it
 * (fail closed on unknown/unactivated domains); the provisioning Lambda
 * creates and activates records.
 */

export type TenantStatus = "PENDING" | "ACTIVE" | "SUSPENDED";

export interface TenantRecord {
  domain: string;
  tenantId: string;
  name: string;
  status: TenantStatus;
  adminEmail: string;
  verificationToken?: string;
  createdAt: string;
}

export class TenantRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantRegistryError";
  }
}

export function tenantIdFromDomain(domain: string): string {
  // Canonical tenantId: the domain with dots replaced by dashes, so it is a
  // safe, collision-free identifier (e.g. `acme.com` → `acme-com`).
  return domain.replace(/\./g, "-");
}

export async function getTenant(
  dynamo: DynamoDBClient,
  tableName: string,
  domain: string
): Promise<TenantRecord | undefined> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { domain: { S: domain.toLowerCase() } },
    })
  );
  const item = result.Item;
  if (!item) return undefined;
  return {
    domain: item.domain.S as string,
    tenantId: item.tenantId.S as string,
    name: item.name.S as string,
    status: item.status.S as TenantStatus,
    adminEmail: item.adminEmail.S as string,
    verificationToken: item.verificationToken?.S,
    createdAt: item.createdAt.S as string,
  };
}

/**
 * Resolves a tenantId for an email domain. Fails closed: an unknown domain
 * or a non-ACTIVE tenant throws (no tenant claim is issued downstream).
 */
export async function resolveTenantId(
  dynamo: DynamoDBClient,
  tableName: string,
  domain: string
): Promise<string> {
  const record = await getTenant(dynamo, tableName, domain);
  if (!record) {
    throw new TenantRegistryError(`Unknown domain "${domain}"`);
  }
  if (record.status !== "ACTIVE") {
    throw new TenantRegistryError(`Tenant for domain "${domain}" is not active (${record.status})`);
  }
  return record.tenantId;
}

export async function createTenant(
  dynamo: DynamoDBClient,
  tableName: string,
  input: { domain: string; name: string; adminEmail: string; verificationToken: string }
): Promise<TenantRecord> {
  const domain = input.domain.toLowerCase();
  const record: TenantRecord = {
    domain,
    tenantId: tenantIdFromDomain(domain),
    name: input.name,
    status: "PENDING",
    adminEmail: input.adminEmail,
    verificationToken: input.verificationToken,
    createdAt: new Date().toISOString(),
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        domain: { S: record.domain },
        tenantId: { S: record.tenantId },
        name: { S: record.name },
        status: { S: record.status },
        adminEmail: { S: record.adminEmail },
        verificationToken: { S: record.verificationToken ?? "" },
        createdAt: { S: record.createdAt },
      },
      // Fail on duplicate domain (409 semantics at the API layer). `domain`
      // is a DynamoDB reserved keyword, so it must be referenced via an
      // expression attribute name.
      ConditionExpression: "attribute_not_exists(#domain)",
      ExpressionAttributeNames: { "#domain": "domain" },
    })
  );

  return record;
}

export async function activateTenant(
  dynamo: DynamoDBClient,
  tableName: string,
  domain: string,
  expectedToken: string
): Promise<TenantRecord> {
  const record = await getTenant(dynamo, tableName, domain);
  if (!record) {
    throw new TenantRegistryError(`Unknown domain "${domain}"`);
  }
  if (record.status === "ACTIVE") {
    return record; // idempotent
  }
  if (record.verificationToken !== expectedToken) {
    throw new TenantRegistryError("Invalid or expired verification token");
  }

  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { domain: { S: domain.toLowerCase() } },
      UpdateExpression: "SET #status = :active REMOVE verificationToken",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": { S: "ACTIVE" } },
    })
  );

  return { ...record, status: "ACTIVE", verificationToken: undefined };
}
