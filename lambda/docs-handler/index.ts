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
    type: "Dual-issuer JWT bearer (Cognito RS256 + Supabase/Lovable Cloud ES256)",
    header: "Authorization: Bearer ***",
    issuers: {
      cognito: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_l8i7P13nO (ID token, RS256)",
      supabase: "https://lxqsievatwcbxhwhubkc.supabase.co/auth/v1 (access token, ES256)",
    },
    context: {
      tenantId: "Cognito: custom:tenantId. Supabase: resolved server-side from membership by email. Absent for users without an organization.",
      email: "The user's email (lowercased)",
      departments: "Comma-separated tenant-namespaced departments (e.g. dev:dept-engineering,dev:org-wide)",
      userId: "Stable user identity",
    },
    note: "The UI must not filter by tenant/department itself; the backend enforces isolation from the verified token. Supabase tokens without a membership record fail closed (401).",
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
      method: "GET",
      path: "/organizations/check-name",
      service: "organizations",
      auth: true,
      description: "Check whether an organization name is available (Google-authenticated user).",
      request: { name: "string (query param)" },
      response: { name: "string", slug: "string", available: "boolean", reason: "string (optional)" },
    },
    {
      method: "POST",
      path: "/organizations",
      service: "organizations",
      auth: true,
      description: "Create an organization; the caller (Google account) becomes its admin.",
      request: { name: "string (required)" },
      response: { tenantId: "string", name: "string", adminEmail: "string", status: "ACTIVE" },
      errors: { 400: "Invalid name", 409: "Name already taken, or caller already belongs to an organization" },
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
      method: "PUT",
      path: "/members/{email}/departments",
      service: "members",
      auth: true,
      adminOnly: true,
      description: "Update a member's department assignments (tenant admin only).",
      request: { departments: "string[] — department names (e.g. [\"dept-engineering\"]). Empty array clears all." },
      response: { email: "string", tenantId: "string", role: "string", status: "string", departments: "string[]" },
      errors: { 403: "Only the tenant admin can manage members", 404: "Member not found in your organization" },
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

function devDocsHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RAG Knowledge Agent — Developer Guide</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--green:#7ee787;--orange:#d29922;--red:#f85149;--mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:2rem 1rem}
.container{max-width:960px;margin:0 auto}
header{margin-bottom:2.5rem;text-align:center}
header h1{font-size:1.8rem;margin-bottom:.5rem}
header p{color:var(--muted);font-size:1rem}
.badge{display:inline-block;padding:.2rem .6rem;border-radius:4px;font-size:.75rem;font-weight:600;margin:.2rem}
.badge.post{background:#1a3a2a;color:var(--green)}
.badge.get{background:#1a2a3a;color:var(--accent)}
.badge.delete{background:#3a1a1a;color:var(--red)}
.badge.auth{background:#3a2a1a;color:var(--orange)}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin-bottom:1rem}
.card h2{font-size:1.1rem;margin-bottom:.75rem;color:var(--accent)}
.card h3{font-size:.95rem;margin:1rem 0 .5rem;color:var(--muted)}
.endpoint{display:flex;align-items:flex-start;gap:.75rem;margin-bottom:.5rem}
.endpoint .method{font-family:var(--mono);font-size:.8rem;font-weight:700;padding:.15rem .5rem;border-radius:3px;min-width:60px;text-align:center;flex-shrink:0}
.endpoint .path{font-family:var(--mono);font-size:.85rem;word-break:break-all}
.endpoint .desc{color:var(--muted);font-size:.85rem;margin-top:.2rem}
code{font-family:var(--mono);background:#21262d;padding:.1rem .3rem;border-radius:3px;font-size:.85rem}
pre{font-family:var(--mono);background:#21262d;padding:1rem;border-radius:6px;overflow-x:auto;font-size:.8rem;line-height:1.5;margin:.5rem 0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.spec-link{display:inline-flex;align-items:center;gap:.5rem;background:#1a2a3a;border:1px solid var(--accent);color:var(--accent);padding:.6rem 1.2rem;border-radius:6px;font-family:var(--mono);font-size:.9rem;margin:1rem 0}
.spec-link:hover{background:var(--accent);color:#0d1117;text-decoration:none}
.tag{font-size:.7rem;padding:.1rem .4rem;border-radius:3px;background:#21262d;color:var(--muted);margin-left:.3rem}
footer{margin-top:2rem;text-align:center;color:var(--muted);font-size:.8rem;padding-top:1rem;border-top:1px solid var(--border)}
</style>
</head><body>
<div class="container">
<header>
<h1>🤖 RAG Knowledge Agent — Developer Guide</h1>
<p>Multi-tenant RAG knowledge agent on AWS Bedrock. Chat, upload, document registry, tenant management.</p>
</header>

<div class="spec-link">
  📄 <a href="/docs">View full API spec (JSON)</a>
</div>

<div class="card">
<h2>Authentication</h2>
<p>All authenticated endpoints accept <strong>dual-issuer JWT bearer tokens</strong>, validated by a Lambda authorizer on API Gateway:</p>
<h3>Issuers</h3>
<pre>
Cognito (RS256)   — https://cognito-idp.us-east-1.amazonaws.com/us-east-1_l8i7P13nO
                   ID token from USER_PASSWORD_AUTH login

Supabase (ES256)  — https://lxqsievatwcbxhwhubkc.supabase.co/auth/v1
                   Access token from Google OAuth via Lovable Cloud
</pre>
<h3>Header</h3>
<pre>Authorization: Bearer &lt;token&gt;</pre>
<h3>Authorizer Context (normalized)</h3>
<pre>
tenantId     — Cognito: custom:tenantId claim
              Supabase: resolved server-side from membership table by email
              Absent for users without an organization

email        — User email (lowercased)

departments  — Comma-separated, namespaced (e.g. acme:dept-engineering,acme:org-wide)

userId       — Stable user identity
</pre>
<p style="margin-top:.5rem;color:var(--orange)">⚠️ <strong>Fail-closed:</strong> Supabase tokens without a membership record return <code>401</code>. The UI must not filter by tenant/department — isolation is enforced server-side.</p>
<p style="margin-top:.5rem;color:var(--muted)">🔑 JWKS is cached with automatic refetch on key rotation. Authorizer cache is disabled (tenant resolved from membership must not go stale).</p>
</div>

<div class="card">
<h2>Base URLs (dev)</h2>
<pre>
Chat          — https://fubcenfu74tcomihthllz7lpaq0wjpfw.lambda-url.us-east-1.on.aws/
Upload        — https://9xgzlkfq3e.execute-api.us-east-1.amazonaws.com
Documents     — https://w1a89nq56l.execute-api.us-east-1.amazonaws.com
Catalog       — https://k46nbxrrl0.execute-api.us-east-1.amazonaws.com
Organizations — https://hvn1deth68.execute-api.us-east-1.amazonaws.com
Members       — https://qsdndxv5o1.execute-api.us-east-1.amazonaws.com
</pre>
<p style="color:var(--muted);font-size:.85rem">URLs are CloudFormation outputs and may change on redeploy. Re-discover with <code>aws cloudformation describe-stacks</code>.</p>
</div>

<div class="card">
<h2>Endpoints</h2>
<div class="endpoint"><span class="method" style="background:#1a3a2a;color:#7ee787">POST</span><span class="path">/ <span class="tag">chat</span></span></div>
<div class="desc">Ask a question grounded in the knowledge base. Returns answer + citations.</div>
<div class="endpoint"><span class="method" style="background:#1a3a2a;color:#7ee787">POST</span><span class="path">/uploads <span class="tag">upload</span></span></div>
<div class="desc">Get a presigned POST URL to upload a document to S3.</div>
<div class="endpoint"><span class="method" style="background:#1a2a3a;color:#58a6ff">GET</span><span class="path">/documents <span class="tag">documents</span></span></div>
<div class="desc">List documents the caller can access (departments + org-wide).</div>
<div class="endpoint"><span class="method" style="background:#1a2a3a;color:#58a6ff">GET</span><span class="path">/documents/{documentId} <span class="tag">documents</span></span></div>
<div class="desc">Full detail for a single document.</div>
<div class="endpoint"><span class="method" style="background:#3a1a1a;color:#f85149">DELETE</span><span class="path">/documents/{documentId} <span class="tag">documents</span></span></div>
<div class="desc">Remove a document (S3 object + sidecar + registry).</div>
<div class="endpoint"><span class="method" style="background:#1a2a3a;color:#58a6ff">GET</span><span class="path">/organizations/check-name <span class="tag">organizations</span></span></div>
<div class="desc">Check if an organization name is available.</div>
<div class="endpoint"><span class="method" style="background:#1a3a2a;color:#7ee787">POST</span><span class="path">/organizations <span class="tag">organizations</span></span></div>
<div class="desc">Create an organization. Caller becomes admin.</div>
<div class="endpoint"><span class="method" style="background:#1a2a3a;color:#58a6ff">GET</span><span class="path">/catalog/departments <span class="tag">catalog</span></span></div>
<div class="desc">List tenant's departments (admin UI dropdowns).</div>
<div class="endpoint"><span class="method" style="background:#1a3a2a;color:#7ee787">POST</span><span class="path">/catalog/departments <span class="tag">catalog · admin</span></span></div>
<div class="desc">Create a department (admin only).</div>
<div class="endpoint"><span class="method" style="background:#3a1a1a;color:#f85149">DELETE</span><span class="path">/catalog/departments/{name} <span class="tag">catalog · admin</span></span></div>
<div class="desc">Delete a department (admin only).</div>
<div class="endpoint"><span class="method" style="background:#1a2a3a;color:#58a6ff">GET</span><span class="path">/catalog/tags <span class="tag">catalog</span></span></div>
<div class="desc">List tenant's normalized tags (upload pickers).</div>
<div class="endpoint"><span class="method" style="background:#1a3a2a;color:#7ee787">POST</span><span class="path">/catalog/tags <span class="tag">catalog · admin</span></span></div>
<div class="desc">Create a tag (admin only).</div>
<div class="endpoint"><span class="method" style="background:#3a1a1a;color:#f85149">DELETE</span><span class="path">/catalog/tags/{name} <span class="tag">catalog · admin</span></span></div>
<div class="desc">Delete a tag (admin only).</div>
<div class="endpoint"><span class="method" style="background:#1a2a3a;color:#58a6ff">GET</span><span class="path">/members <span class="tag">members · admin</span></span></div>
<div class="desc">List tenant's members (admin only).</div>
<div class="endpoint"><span class="method" style="background:#1a3a2a;color:#7ee787">POST</span><span class="path">/members/invite <span class="tag">members · admin</span></span></div>
<div class="desc">Invite a user by email (admin only).</div>
<div class="endpoint"><span class="method" style="background:#1a3a2a;color:#7ee787">POST</span><span class="path">/members/accept <span class="tag">members</span></span></div>
<div class="desc">Accept the caller's own invitation.</div>
<div class="endpoint"><span class="method" style="background:#3a2a1a;color:#d29922">PUT</span><span class="path">/members/{email}/departments <span class="tag">members · admin</span></span></div>
<div class="desc">Update a member's department assignments (admin only).</div>
<div class="endpoint"><span class="method" style="background:#3a1a1a;color:#f85149">DELETE</span><span class="path">/members/{email} <span class="tag">members · admin</span></span></div>
<div class="desc">Remove a member (admin only).</div>
</div>

<div class="card">
<h2>Integration Flow (Lovable Cloud / Supabase)</h2>
<pre>
1. User signs in with Google via Lovable Cloud (Supabase Auth)
   → Supabase returns an ES256 access token (iss: https://&lt;project&gt;.supabase.co/auth/v1)

2. Frontend sends the token as Bearer to any API endpoint
   → Authorization: Bearer &lt;supabase-access-token&gt;

3. API Gateway Lambda authorizer validates the token
   → Routes by iss: Supabase → ES256 + Supabase JWKS
   → Validates iss, aud ("authenticated"), exp, signature
   → Resolves tenant by email from the membership table
   → Returns normalized context: { tenantId, email, departments, userId }

4. Handler receives requestContext.authorizer.lambda context
   → Uses tenantId for data isolation
   → Uses departments for row-level filtering
</pre>
</div>

<div class="card">
<h2>Quick Start — Example Request</h2>
<pre>
# Chat (Supabase token)
curl -X POST https://fubcenfu74tcomihthllz7lpaq0wjpfw.lambda-url.us-east-1.on.aws/ \\
  -H "content-type: application/json" \\
  -H "authorization: Bearer &lt;supabase-token&gt;" \\
  -d '{"message":"What is the remote work policy?"}'

# Upload (get presigned URL)
curl -X POST https://9xgzlkfq3e.execute-api.us-east-1.amazonaws.com/uploads \\
  -H "content-type: application/json" \\
  -H "authorization: Bearer &lt;supabase-token&gt;" \\
  -d '{"department":"dept-engineering","filename":"report.pdf","contentType":"application/pdf"}'
</pre>
</div>

<div class="card">
<h2>Error Handling</h2>
<pre>
400 — Missing/invalid field, unsupported content type, invalid tags
401 — Missing/invalid/expired token, or Supabase token without membership
403 — Not authorized (wrong department, non-admin, or not a member)
404 — Resource not found within the caller's tenant
409 — Conflict (name taken, already a member)
500 — Internal server error
</pre>
<p style="margin-top:.5rem;color:var(--muted)">Error bodies are JSON: <code>{"error":"..."}</code>. Display verbatim in the UI.</p>
</div>

<footer>
  RAG Knowledge Agent · AWS Bedrock · <a href="/docs">API Spec (JSON)</a> · Generated from deployed code
</footer>
</div>
</body></html>`;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? "";
  const accept = event.headers?.["accept"] ?? "";

  if (path.endsWith("/dev-docs") || path.endsWith("/dev-docs/")) {
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: devDocsHtml(),
    };
  }

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
