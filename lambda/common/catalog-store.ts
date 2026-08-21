import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

/**
 * Per-tenant catalog access (departments + normalized tags).
 *
 * The catalog is the source of truth for the admin UI's dropdowns and for
 * tag normalization on upload. Items are keyed by (tenantId, itemKey) where
 * itemKey is `{kind}#{name}`.
 */

export type CatalogKind = "department" | "tag";

export interface CatalogItem {
  tenantId: string;
  kind: CatalogKind;
  name: string;
  createdBy: string;
  createdAt: string;
}

/** Normalizes a department/tag name: trim + lowercase. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Validates a name against the allowed character set. Departments and tags
 * must be alphanumeric with hyphens/underscores (no spaces, no punctuation),
 * so they map cleanly to S3 key segments and retrieval filters.
 */
export function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

function itemKey(kind: CatalogKind, name: string): string {
  return `${kind}#${name}`;
}

function toItem(item: CatalogItem): Record<string, AttributeValue> {
  return {
    tenantId: { S: item.tenantId },
    itemKey: { S: itemKey(item.kind, item.name) },
    kind: { S: item.kind },
    name: { S: item.name },
    createdBy: { S: item.createdBy },
    createdAt: { S: item.createdAt },
  };
}

function fromItem(item: Record<string, AttributeValue> | undefined): CatalogItem | undefined {
  if (!item) return undefined;
  return {
    tenantId: item.tenantId.S as string,
    kind: item.kind.S as CatalogKind,
    name: item.name.S as string,
    createdBy: item.createdBy.S as string,
    createdAt: item.createdAt.S as string,
  };
}

/** Lists all catalog items of a given kind for a tenant, sorted by name. */
export async function listCatalog(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string,
  kind: CatalogKind
): Promise<CatalogItem[]> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "tenantId = :tenantId AND begins_with(itemKey, :prefix)",
      ExpressionAttributeValues: {
        ":tenantId": { S: tenantId },
        ":prefix": { S: `${kind}#` },
      },
    })
  );
  const items = (result.Items ?? [])
    .map(fromItem)
    .filter((i): i is CatalogItem => Boolean(i));
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads a single catalog item, or undefined if absent. */
export async function getCatalogItem(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string,
  kind: CatalogKind,
  name: string
): Promise<CatalogItem | undefined> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { tenantId: { S: tenantId }, itemKey: { S: itemKey(kind, name) } },
    })
  );
  return fromItem(result.Item);
}

/** Creates a catalog item (idempotent — overwrites on same name). */
export async function putCatalogItem(
  dynamo: DynamoDBClient,
  tableName: string,
  item: CatalogItem
): Promise<void> {
  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: toItem(item),
    })
  );
}

/** Deletes a catalog item by (tenantId, kind, name). */
export async function deleteCatalogItem(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string,
  kind: CatalogKind,
  name: string
): Promise<void> {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { tenantId: { S: tenantId }, itemKey: { S: itemKey(kind, name) } },
    })
  );
}

/**
 * Validates a set of upload tags against the tenant's normalized tag catalog.
 *
 * Returns `{ valid: true }` when every tag is known, or `{ valid: false,
 * unknown: [...] }` listing the tags that are not in the catalog. When the
 * tenant has no tags defined yet, an empty catalog is treated as "allow
 * anything" (backward-compatible rollout) — the admin can seed the catalog
 * and then uploads are enforced against it.
 */
export async function validateTagsAgainstCatalog(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string,
  tags: string[]
): Promise<{ valid: boolean; unknown: string[] }> {
  if (tags.length === 0) return { valid: true, unknown: [] };

  const catalog = await listCatalog(dynamo, tableName, tenantId, "tag");
  if (catalog.length === 0) return { valid: true, unknown: [] };

  const known = new Set(catalog.map((c) => c.name));
  const unknown = tags.filter((t) => !known.has(t));
  return { valid: unknown.length === 0, unknown };
}
