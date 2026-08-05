import { randomUUID } from "crypto";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { COMPANY_WIDE, parseDepartmentClaims, userCanAccessDepartment } from "../common/auth";

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

export interface UploadRequestBody {
  department: string;
  filename: string;
  contentType: string;
}

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
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
  return { department, filename, contentType };
}

export function buildObjectKey(department: string, filename: string): string {
  // Reject path traversal / separator injection in the original filename —
  // it becomes part of the S3 key, never trust it verbatim.
  const safeFilename = filename.replace(/[/\\]/g, "_");
  return `${department}/${randomUUID()}-${safeFilename}`;
}

export async function handleUploadRequest(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  s3Client: S3Client,
  bucketName: string
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

  // Server-side enforcement — a user cannot upload into a department they
  // don't belong to, except company-wide, which anyone may upload to
  // (spec Section 4.2 / Section 6, Security Considerations).
  if (body.department !== COMPANY_WIDE && !userCanAccessDepartment(userDepartments, body.department)) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: `Not a member of department "${body.department}"` }),
    };
  }

  const key = buildObjectKey(body.department, body.filename);

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: bucketName,
    Key: key,
    Conditions: [
      ["content-length-range", MIN_UPLOAD_BYTES, MAX_UPLOAD_BYTES],
      ["eq", "$Content-Type", body.contentType],
    ],
    Fields: {
      "Content-Type": body.contentType,
      "x-amz-meta-department": body.department,
    },
    Expires: PRESIGNED_POST_EXPIRY_SECONDS,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ url, fields, key }),
  };
}

const s3 = new S3Client({});
const BUCKET_NAME = process.env.UPLOAD_BUCKET_NAME ?? "";

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!BUCKET_NAME) {
    throw new Error("UPLOAD_BUCKET_NAME environment variable is not set");
  }
  return handleUploadRequest(event, s3, BUCKET_NAME);
};

