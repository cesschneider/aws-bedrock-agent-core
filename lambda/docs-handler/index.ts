import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/**
 * Public API documentation endpoint.
 *
 * Serves the full, up-to-date API spec as JSON (and a human-readable HTML
 * view) with no authentication — this is public documentation, not data.
 * The spec is embedded at build time so the endpoint is always consistent
 * with the deployed code.
 */

const API_SPEC = {
  title: "RAG Knowledge Agent API",
  version: "1.0.0",
  description:
    "Multi-tenant RAG knowledge agent. Chat, upload, document registry, and tenant provisioning.",
  baseUrls: {
    dev: {
      chat: "https://fubcenfu74tcomihthllz7lpaq0wjpfw.lambda-url.us-east-1.on.aws/",
      upload: "https://9xgzlkfq3e.execute-api.us-east-1.amazonaws.com",
      documents: "https://w1a89nq56l.execute-api.us-east-1.amazonaws.com",
      provisioning: "https://8jpargtrs5.execute-api.us-east-1.amazonaws.com",
    },
  },
  auth: {
    type: "Cognito JWT bearer (ID token)",
    header: "Authorization: Bearer <id-token>",
    claims: {
      "custom:tenantId": "The user's tenant (e.g. dev)",
      "custom:departments": "Comma-separated tenant-namespaced departments (e.g. dev:dept-engineering,dev:org-wide)",
    },
    note: "The UI must not filter by tenant/department itself; the backend enforces isolation from the token claims.",
  },
  endpoints: [
    {
      method: "POST",
      path: "/",
      service: "chat",
      auth: true,
      description: "Ask a question, grounded in the knowledge base.",
      request: {
        message: "string (required) — the question",
        sessionId: "string (optional) — omit for a new conversation, reuse to continue",
        departments: "string[] (optional) — subset of the caller's departments to narrow retrieval to",
        tags: "string[] (optional) — narrow retrieval to documents carrying any of these tags",
      },
      response: {
        answer: "string — grounded answer, or the zero-result message",
        citations: "array of { referenceId, url }",
        sessionId: "string",
        turnId: "string",
      },
      errors: {
        400: "Missing or invalid 'message' field",
        401: "Missing/invalid/expired token",
        403: "Not a member of department \"…\" (when a requested department is not in the caller's claims)",
        500: "Internal server error",
      },
    },
    {
      method: "POST",
      path: "/uploads",
      service: "upload",
      auth: true,
      description: "Get a presigned POST URL to upload a document.",
      request: {
        department: "string (required) — department name or 'org-wide'",
        filename: "string (required)",
        contentType: "string (required) — application/pdf, .docx, text/plain, .pptx",
        tags: "string[] (optional) — max 20 tags, 64 chars each",
      },
      response: {
        url: "string — S3 presigned POST URL",
        fields: "object — form fields to include in the multipart POST",
        key: "string — S3 object key",
        documentId: "string — stable id for get/delete",
      },
      errors: {
        400: "Missing/invalid field, unsupported content type, or invalid tags",
        401: "Missing tenant claim",
        403: "Not a member of department \"…\"",
      },
    },
    {
      method: "GET",
      path: "/documents",
      service: "documents",
      auth: true,
      description: "List documents the caller may access (their departments + org-wide).",
      response: {
        documents: "array of document objects (see document shape)",
      },
    },
    {
      method: "GET",
      path: "/documents/{documentId}",
      service: "documents",
      auth: true,
      description: "Full detail for a single document.",
      errors: {
        404: "Document not found",
        403: "Not a member of the document's department",
      },
    },
    {
      method: "DELETE",
      path: "/documents/{documentId}",
      service: "documents",
      auth: true,
      description: "Remove a document (S3 object + sidecar + registry record).",
      response: { deleted: "boolean", documentId: "string" },
    },
    {
      method: "POST",
      path: "/signup",
      service: "provisioning",
      auth: false,
      description: "Create a PENDING tenant.",
      request: { name: "string", adminEmail: "string", domain: "string" },
      response: { domain: "string", tenantId: "string", status: "PENDING" },
    },
    {
      method: "POST",
      path: "/confirm",
      service: "provisioning",
      auth: false,
      description: "Activate a tenant after admin email confirmation.",
      request: { domain: "string", token: "string" },
      response: { domain: "string", tenantId: "string", status: "ACTIVE" },
    },
    {
      method: "GET",
      path: "/catalog/departments",
      service: "catalog",
      auth: true,
      description: "List the tenant's administrable departments (for admin UI dropdowns).",
      response: { departments: "string[]" },
    },
    {
      method: "POST",
      path: "/catalog/departments",
      service: "catalog",
      auth: true,
      adminOnly: true,
      description: "Create a department (tenant admin only).",
      request: { name: "string — lowercase alphanumeric/hyphen/underscore, max 64" },
      response: { name: "string", kind: "department" },
      errors: { 403: "Only the tenant admin can manage the catalog", 400: "Invalid name" },
    },
    {
      method: "DELETE",
      path: "/catalog/departments/{name}",
      service: "catalog",
      auth: true,
      adminOnly: true,
      description: "Delete a department (tenant admin only).",
      response: { deleted: "boolean", name: "string", kind: "department" },
    },
    {
      method: "GET",
      path: "/catalog/tags",
      service: "catalog",
      auth: true,
      description: "List the tenant's normalized tags (for upload tag pickers).",
      response: { tags: "string[]" },
    },
    {
      method: "POST",
      path: "/catalog/tags",
      service: "catalog",
      auth: true,
      adminOnly: true,
      description: "Create a normalized tag (tenant admin only).",
      request: { name: "string — lowercase alphanumeric/hyphen/underscore, max 64" },
      response: { name: "string", kind: "tag" },
    },
    {
      method: "DELETE",
      path: "/catalog/tags/{name}",
      service: "catalog",
      auth: true,
      adminOnly: true,
      description: "Delete a normalized tag (tenant admin only).",
      response: { deleted: "boolean", name: "string", kind: "tag" },
    },
    {
      method: "GET",
      path: "/members",
      service: "members",
      auth: true,
      adminOnly: true,
      description: "List the tenant's members (tenant admin only).",
      response: { members: "array of { email, role, status, invitedBy, invitedAt, acceptedAt }" },
    },
    {
      method: "POST",
      path: "/members/invite",
      service: "members",
      auth: true,
      adminOnly: true,
      description: "Invite a user by email (tenant admin only). The first user of a tenant is the provisioning admin.",
      request: { email: "string (required)" },
      response: { email: "string", tenantId: "string", role: "member", status: "PENDING" },
      errors: { 403: "Only the tenant admin can manage members", 409: "This email is already a member of an organization" },
    },
    {
      method: "POST",
      path: "/members/accept",
      service: "members",
      auth: true,
      description: "Accept the caller's own invitation, activating their membership.",
      response: { email: "string", tenantId: "string", role: "string", status: "ACTIVE" },
      errors: { 404: "No invitation found for this email" },
    },
    {
      method: "DELETE",
      path: "/members/{email}",
      service: "members",
      auth: true,
      adminOnly: true,
      description: "Remove a member (tenant admin only). An admin cannot remove themselves.",
      response: { deleted: "boolean", email: "string" },
      errors: { 400: "An admin cannot remove themselves" },
    },
  ],
  documentShape: {
    documentId: "string — stable id",
    tenantId: "string — org the document belongs to",
    department: "string — human-facing department name",
    filename: "string",
    contentType: "string",
    sizeBytes: "number — 0 until indexed",
    tags: "string[]",
    status: "PENDING | INDEXED | FAILED",
    uploadedBy: "string",
    uploadedAt: "string (ISO 8601)",
    indexedAt: "string (ISO 8601) | undefined",
  },
};

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function html(): string {
  const pretty = JSON.stringify(API_SPEC, null, 2);
  return `<!doctype html><html><head><meta charset="utf-8"><title>RAG Knowledge Agent API</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
pre{background:#f6f8fa;padding:1rem;border-radius:6px;overflow:auto;font-size:13px}</style></head>
<body><h1>RAG Knowledge Agent API</h1><p>Public API documentation. See the JSON at <code>/docs</code>.</p>
<pre>${pretty.replace(/</g, "&lt;")}</pre></body></html>`;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  const accept = event.headers?.["accept"] ?? "";

  if (path.endsWith("/docs") || path.endsWith("/docs/")) {
    if (accept.includes("text/html")) {
      return {
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: html(),
      };
    }
    return json(200, API_SPEC);
  }

  return json(404, { error: "Not found" });
};
