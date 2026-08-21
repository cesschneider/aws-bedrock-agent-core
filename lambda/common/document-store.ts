import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

/**
 * Document registry access (multi-tenant design §4.2 extension).
 *
 * The registry is the source of truth for the document list/get/delete API.
 * A record is written at upload time (status PENDING) and updated at
 * ingestion time (size + status INDEXED). It carries the permission scope
 * (tenant + department), tags, timestamps, and ingestion status.
 */

export type DocumentStatus = "PENDING" | "INDEXED" | "FAILED";

export interface DocumentRecord {
  /** Tenant (organization) the document belongs to — partition key. */
  tenantId: string;
  /** UUID embedded in the S3 object key — sort key. */
  documentId: string;
  /** Tenant-namespaced department, e.g. `acme-com:dept-engineering`. */
  department: string;
  /** Human-facing department name, e.g. `dept-engineering`. */
  plainDepartment: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  tags: string[];
  status: DocumentStatus;
  s3Key: string;
  uploadedBy: string;
  uploadedAt: string;
  indexedAt?: string;
}

/** Matches the leading UUID in `{uuid}-{filename}` (the S3 key's last segment). */
const UUID_PREFIX_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/;

/**
 * Extracts the documentId (UUID) from an S3 object key of the form
 * `{tenantId}/{department}/{uuid}-{filename}`.
 */
export function documentIdFromKey(key: string): string {
  const segments = key.split("/");
  const last = segments[segments.length - 1] ?? "";
  const match = last.match(UUID_PREFIX_RE);
  if (!match) {
    throw new Error(`Cannot determine documentId from object key "${key}"`);
  }
  return match[1];
}

function toItem(record: DocumentRecord): Record<string, AttributeValue> {
  const item: Record<string, AttributeValue> = {
    tenantId: { S: record.tenantId },
    documentId: { S: record.documentId },
    department: { S: record.department },
    plainDepartment: { S: record.plainDepartment },
    filename: { S: record.filename },
    contentType: { S: record.contentType },
    sizeBytes: { N: String(record.sizeBytes) },
    status: { S: record.status },
    s3Key: { S: record.s3Key },
    uploadedBy: { S: record.uploadedBy },
    uploadedAt: { S: record.uploadedAt },
  };
  if (record.tags.length > 0) {
    item.tags = { SS: record.tags };
  }
  if (record.indexedAt) {
    item.indexedAt = { S: record.indexedAt };
  }
  return item;
}

function fromItem(item: Record<string, AttributeValue> | undefined): DocumentRecord | undefined {
  if (!item) return undefined;
  return {
    tenantId: item.tenantId.S as string,
    documentId: item.documentId.S as string,
    department: item.department.S as string,
    plainDepartment: item.plainDepartment.S as string,
    filename: item.filename.S as string,
    contentType: item.contentType.S as string,
    sizeBytes: Number(item.sizeBytes.N),
    tags: item.tags?.SS ?? [],
    status: item.status.S as DocumentStatus,
    s3Key: item.s3Key.S as string,
    uploadedBy: item.uploadedBy.S as string,
    uploadedAt: item.uploadedAt.S as string,
    indexedAt: item.indexedAt?.S,
  };
}

/** Writes a new document record (status PENDING) at upload time. */
export async function putDocument(
  dynamo: DynamoDBClient,
  tableName: string,
  record: DocumentRecord
): Promise<void> {
  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: toItem(record),
    })
  );
}

/** Reads a single document record by (tenantId, documentId). */
export async function getDocument(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string,
  documentId: string
): Promise<DocumentRecord | undefined> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { tenantId: { S: tenantId }, documentId: { S: documentId } },
    })
  );
  return fromItem(result.Item);
}

/**
 * Lists documents for a tenant, optionally restricted to a set of
 * tenant-namespaced departments the caller may access. Returns most-recent
 * first (uploadedAt descending).
 */
export async function listDocuments(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string,
  departments?: string[]
): Promise<DocumentRecord[]> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":tenantId": { S: tenantId } },
      ScanIndexForward: false,
    })
  );

  const records = (result.Items ?? []).map(fromItem).filter((r): r is DocumentRecord => Boolean(r));

  if (!departments || departments.length === 0) {
    return records;
  }
  const allowed = new Set(departments);
  return records.filter((r) => allowed.has(r.department));
}

/** Deletes a document record by (tenantId, documentId). */
export async function deleteDocument(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string,
  documentId: string
): Promise<void> {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { tenantId: { S: tenantId }, documentId: { S: documentId } },
    })
  );
}

/**
 * Updates a document's ingestion status, size, and indexedAt timestamp.
 * Called by kb-sync-trigger once the S3 object is observed and ingestion is
 * started. Uses an UpdateItem so it never clobbers fields written at upload.
 */
export async function markDocumentIndexed(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string,
  documentId: string,
  sizeBytes: number,
  indexedAt: string
): Promise<void> {
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { tenantId: { S: tenantId }, documentId: { S: documentId } },
      UpdateExpression: "SET #status = :status, sizeBytes = :size, indexedAt = :at",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": { S: "INDEXED" },
        ":size": { N: String(sizeBytes) },
        ":at": { S: indexedAt },
      },
    })
  );
}
