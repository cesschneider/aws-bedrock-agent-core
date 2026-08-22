import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  deleteDocument,
  getDocument,
  listDocuments,
  type DocumentRecord,
} from "../common/document-store";
import { tenantOrgWide } from "../common/auth";
import { authContextFromEvent, type AuthorizedEvent } from "../common/authorizer-context";

/**
 * Document registry API (multi-tenant design §4.2 extension).
 *
 * Exposes the list/get/delete endpoints for uploaded documents:
 *   GET    /documents            — list documents the caller may access
 *   GET    /documents/{id}       — full detail for a single document
 *   DELETE /documents/{id}       — remove a document (registry + S3 object)
 *
 * All access is scoped to the caller's tenant (from the verified JWT) and
 * their department memberships. A caller can never list, read, or delete a
 * document from another tenant, or from a department they don't belong to.
 */

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
const tableName = process.env.DOCUMENT_REGISTRY_TABLE_NAME ?? "";
const bucketName = process.env.DOCUMENTS_BUCKET_NAME ?? "";

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function toPublic(record: DocumentRecord) {
  return {
    documentId: record.documentId,
    tenantId: record.tenantId,
    department: record.plainDepartment,
    filename: record.filename,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    tags: record.tags,
    status: record.status,
    uploadedBy: record.uploadedBy,
    uploadedAt: record.uploadedAt,
    indexedAt: record.indexedAt,
  };
}

interface AuthContext {
  tenantId: string;
  departments: string[];
}

function authFromEvent(event: AuthorizedEvent): AuthContext {
  const auth = authContextFromEvent(event);
  const departments = Array.from(
    new Set([...auth.departments, tenantOrgWide(auth.tenantId)])
  );
  return { tenantId: auth.tenantId, departments };
}

export async function handleList(
  event: AuthorizedEvent
): Promise<APIGatewayProxyStructuredResultV2> {
  const auth = authFromEvent(event);
  const records = await listDocuments(dynamo, tableName, auth.tenantId, auth.departments);
  return json(200, { documents: records.map(toPublic) });
}

export async function handleGet(
  event: AuthorizedEvent,
  documentId: string
): Promise<APIGatewayProxyStructuredResultV2> {
  const auth = authFromEvent(event);
  const record = await getDocument(dynamo, tableName, auth.tenantId, documentId);
  if (!record) {
    return json(404, { error: "Document not found" });
  }
  if (!auth.departments.includes(record.department)) {
    return json(403, { error: "Not a member of the document's department" });
  }
  return json(200, toPublic(record));
}

export async function handleDelete(
  event: AuthorizedEvent,
  documentId: string
): Promise<APIGatewayProxyStructuredResultV2> {
  const auth = authFromEvent(event);
  const record = await getDocument(dynamo, tableName, auth.tenantId, documentId);
  if (!record) {
    return json(404, { error: "Document not found" });
  }
  if (!auth.departments.includes(record.department)) {
    return json(403, { error: "Not a member of the document's department" });
  }

  // Remove the S3 object (and its metadata sidecar) so the document is no
  // longer retrievable, then remove the registry record.
  await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: record.s3Key }));
  await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: `${record.s3Key}.metadata.json` }));
  await deleteDocument(dynamo, tableName, auth.tenantId, documentId);

  return json(200, { deleted: true, documentId });
}

export const handler = async (
  event: AuthorizedEvent
): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!tableName || !bucketName) {
    return json(500, { error: "DOCUMENT_REGISTRY_TABLE_NAME and DOCUMENTS_BUCKET_NAME are required" });
  }

  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath ?? event.requestContext.http.path ?? "";
    const segments = path.split("/").filter(Boolean); // e.g. ["documents", "<id>"]

    if (method === "GET" && segments.length === 1 && segments[0] === "documents") {
      return await handleList(event);
    }
    if (method === "GET" && segments.length === 2 && segments[0] === "documents") {
      return await handleGet(event, decodeURIComponent(segments[1]));
    }
    if (method === "DELETE" && segments.length === 2 && segments[0] === "documents") {
      return await handleDelete(event, decodeURIComponent(segments[1]));
    }
    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("Documents handler error:", err);
    const e = err as { statusCode?: number; message?: string };
    return json(e.statusCode ?? 500, { error: e.message ?? "Internal server error" });
  }
};
