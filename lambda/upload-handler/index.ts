import { randomUUID } from "crypto";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { ORG_WIDE, namespacedDepartment, parseDepartmentClaims, tenantOrgWide, userCanAccessDepartment } from "../common/auth";
import { putDocument, type DocumentRecord } from "../common/document-store";

/** Bedrock KB default-supported office document types (spec Section 2, Goals). */
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "text/plain",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
]);

/** No large-document handling needed for v1 (spec Section 8, Launch Scale). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const MIN_UPLOAD_BYTES = 1; // reject 0-byte files (Eng review addition)
const PRESIGNED_POST_EXPIRY_SECONDS = 300;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;

export interface UploadRequestBody {
  department: string;
  filename: string;
  contentType: string;
  tags?: string[];
}

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

function normalizeTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new UploadValidationError("tags must be an array of strings");
  }
  const tags = raw.map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t.length > 0);
  if (tags.length > MAX_TAGS) {
    throw new UploadValidationError(`too many tags (max ${MAX_TAGS})`);
  }
  for (const tag of tags) {
    if (tag.length > MAX_TAG_LENGTH) {
      throw new UploadValidationError(`tag "${tag}" exceeds ${MAX_TAG_LENGTH} characters`);
    }
  }
  // Dedupe, preserving order.
  return Array.from(new Set(tags));
}

function parseBody(rawBody: string | undefined): UploadRequestBody {
  if (!rawBody) {
    throw new UploadValidationError("Request body is required");
  }
  let parsed: Partial<UploadRequestBody>;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new UploadValidationError("Request body must be valid JSON");
  }
  const { department, filename, contentType } = parsed;
  if (!department || typeof department !== "string") {
    throw new UploadValidationError("department is required");
  }
  if (!filename || typeof filename !== "string") {
    throw new UploadValidationError("filename is required");
  }
  if (!contentType || typeof contentType !== "string") {
    throw new UploadValidationError("contentType is required");
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new UploadValidationError(
      `contentType "${contentType}" is not supported (allowed: pdf, docx, txt, pptx)`
    );
  }
  const tags = normalizeTags(parsed.tags);
  return { department, filename, contentType, tags };
}

export function buildObjectKey(tenantId: string, department: string, documentId: string, filename: string): string {
  // Reject path traversal / separator injection in the original filename —
  // it becomes part of the S3 key, never trust it verbatim.
  const safeFilename = filename.replace(/[/\\]/g, "_");
  return `${tenantId}/${department}/${documentId}-${safeFilename}`;
}

export interface UploadDependencies {
  s3Client: S3Client;
  dynamo: DynamoDBClient;
  bucketName: string;
  registryTableName: string;
}

export async function handleUploadRequest(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  deps: UploadDependencies
): Promise<APIGatewayProxyStructuredResultV2> {
  let body: UploadRequestBody;
  try {
    body = parseBody(event.body);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
    }
    throw err;
  }

  const claims = event.requestContext.authorizer.jwt.claims as Record<string, string>;
  const userDepartments = parseDepartmentClaims(claims);

  // Tenant is derived from the verified JWT (multi-tenant design §4.2/§6) —
  // never from the request body. Missing tenant fails closed.
  const tenantId = claims["custom:tenantId"];
  if (!tenantId || tenantId.trim().length === 0) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Missing tenant claim (custom:tenantId)" }),
    };
  }

  // Every user can upload to their tenant's org-wide scope.
  const effectiveDepartments = Array.from(
    new Set([...userDepartments, tenantOrgWide(tenantId.trim())])
  );

  // Server-side enforcement — a user cannot upload into a department they
  // don't belong to, except org-wide, which anyone in the tenant may upload
  // to (spec Section 4.2 / Section 6, Security Considerations).
  const targetDepartment =
    body.department === ORG_WIDE
      ? namespacedDepartment(tenantId.trim(), ORG_WIDE)
      : namespacedDepartment(tenantId.trim(), body.department);
  if (!userCanAccessDepartment(effectiveDepartments, targetDepartment)) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: `Not a member of department "${body.department}"` }),
    };
  }

  const documentId = randomUUID();
  const key = buildObjectKey(tenantId.trim(), body.department, documentId, body.filename);

  // Persist a PENDING registry record so the document is immediately visible
  // to the list/get API, even before ingestion completes. kb-sync-trigger
  // updates size + status to INDEXED once the object is observed.
  const uploadedBy = claims["cognito:username"] ?? claims["sub"] ?? "unknown";
  const record: DocumentRecord = {
    tenantId: tenantId.trim(),
    documentId,
    department: targetDepartment,
    plainDepartment: body.department,
    filename: body.filename,
    contentType: body.contentType,
    sizeBytes: 0,
    tags: body.tags ?? [],
    status: "PENDING",
    s3Key: key,
    uploadedBy,
    uploadedAt: new Date().toISOString(),
  };
  await putDocument(deps.dynamo, deps.registryTableName, record);

  const { url, fields } = await createPresignedPost(deps.s3Client, {
    Bucket: deps.bucketName,
    Key: key,
    Conditions: [
      ["content-length-range", MIN_UPLOAD_BYTES, MAX_UPLOAD_BYTES],
      ["eq", "$Content-Type", body.contentType],
    ],
    Fields: {
      "Content-Type": body.contentType,
      "x-amz-meta-tenant-id": tenantId.trim(),
      "x-amz-meta-department": body.department,
      "x-amz-meta-document-id": documentId,
    },
    Expires: PRESIGNED_POST_EXPIRY_SECONDS,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ url, fields, key, documentId }),
  };
}

const s3 = new S3Client({});
const dynamo = new DynamoDBClient({});
const BUCKET_NAME = process.env.UPLOAD_BUCKET_NAME ?? "";
const REGISTRY_TABLE_NAME = process.env.DOCUMENT_REGISTRY_TABLE_NAME ?? "";

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!BUCKET_NAME) {
    throw new Error("UPLOAD_BUCKET_NAME environment variable is not set");
  }
  if (!REGISTRY_TABLE_NAME) {
    throw new Error("DOCUMENT_REGISTRY_TABLE_NAME environment variable is not set");
  }
  return handleUploadRequest(event, {
    s3Client: s3,
    dynamo,
    bucketName: BUCKET_NAME,
    registryTableName: REGISTRY_TABLE_NAME,
  });
};
