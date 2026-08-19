# RAG Knowledge Agent — API Reference

Base URLs (dev account, us-east-1):

| Service | Base URL |
|---|---|
| Chat | `https://fubcenfu74tcomihthllz7lpaq0wjpfw.lambda-url.us-east-1.on.aws/` |
| Upload | `https://9xgzlkfq3e.execute-api.us-east-1.amazonaws.com` |
| Provisioning | `https://8jpargtrs5.execute-api.us-east-1.amazonaws.com` |

Cognito (dev):

| Setting | Value |
|---|---|
| User Pool ID | `us-east-1_l8i7P13nO` |
| Client ID | `3cps1plup69q20rkqpic0caeik` |
| Region | `us-east-1` |

> These values are also emitted as CloudFormation stack outputs
> (`ChatHandlerFunctionUrl`, `CognitoUserPoolId`, `CognitoClientId`,
> `TenantProvisioningApiTenantProvisioningApiUrl…`, `UploadApiUploadApiUrl…`).

---

## Authentication

All authenticated endpoints use **Cognito JWT bearer tokens**.

- **Chat** — pass the **ID token** in the `Authorization` header:
  `Authorization: Bearer <idToken>`. (The Function URL has no gateway
  authorizer; the Lambda validates the JWT itself.)
- **Upload** — API Gateway's built-in Cognito JWT authorizer validates the
  token before the Lambda runs. Send the **ID token** the same way:
  `Authorization: Bearer <idToken>`.
- **Provisioning** — **no auth** (anonymous sign-up by design).

The ID token carries the tenant and department scoping as claims:

| Claim | Meaning |
|---|---|
| `custom:tenantId` | The user's tenant (e.g. `acme-com`). Emitted by pre-token-generation. |
| `cognito:groups` | Tenant-namespaced departments (e.g. `acme-com:engineering`, `acme-com:org-wide`). |

**How users get these claims:** identity is federated from Google Workspace.
The pre-token-generation trigger maps the user's Workspace group memberships
to departments and derives the tenant from the email domain (via the tenant
registry). Native (non-Google) users get a fixed `dev` tenant and their
native Cognito group as the department.

---

## 1. Chat — ask a question

`POST /` (Function URL)

**Headers**

```
content-type: application/json
authorization: Bearer <idToken>
```

**Request body**

```json
{
  "message": "What is the FY2026 budget?",
  "sessionId": "optional-uuid-for-multi-turn-conversation"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | The user's question. |
| `sessionId` | string | no | Omit to start a new conversation; reuse to continue one. |

**Response `200`**

```json
{
  "answer": "The FY2026 budget allocates $12M to R&D.",
  "citations": [
    { "referenceId": "ref-1", "url": "https://signed.example.com/doc?sig=…" }
  ],
  "sessionId": "uuid",
  "turnId": "2026-08-19T…#abc12345"
}
```

| Field | Type | Notes |
|---|---|---|
| `answer` | string | Grounded answer, or the zero-result message if nothing matched. |
| `citations` | array | Presigned download links for the source documents. Empty if none. |
| `sessionId` | string | Echo back this value on the next turn to continue the conversation. |
| `turnId` | string | Unique id for this turn. |

**Errors**

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error":"Missing or invalid 'message' field"}` | Bad body. |
| 401 | `{"error":"…"}` | Missing/invalid/expired token, or missing `custom:tenantId`. |
| 500 | `{"error":"Internal server error"}` | Unexpected failure. |

**Isolation guarantees:** the answer is scoped to the caller's tenant and
departments at the vector-search level. A user can never retrieve content
from another department in the same tenant, nor from another tenant.
Citations are re-checked for tenant + department access at link-generation
time.

---

## 2. Upload — get a presigned POST for a document

`POST /uploads`

**Headers**

```
content-type: application/json
authorization: Bearer <idToken>
```

**Request body**

```json
{
  "department": "engineering",
  "filename": "architecture.pdf",
  "contentType": "application/pdf"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `department` | string | yes | Human-facing department name, or `org-wide`. Must be a department the caller belongs to. |
| `filename` | string | yes | Original filename (path separators are sanitized). |
| `contentType` | string | yes | One of `application/pdf`, `.docx`, `text/plain`, `.pptx` (see below). |

**Allowed content types**

- `application/pdf`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (.docx)
- `text/plain`
- `application/vnd.openxmlformats-officedocument.presentationml.presentation` (.pptx)

**Response `200`**

```json
{
  "url": "https://raw-documents-dev-….s3.amazonaws.com/",
  "fields": {
    "key": "acme-com/engineering/<uuid>-architecture.pdf",
    "Content-Type": "application/pdf",
    "x-amz-meta-tenant-id": "acme-com",
    "x-amz-meta-department": "engineering",
    "x-amz-algorithm": "…",
    "x-amz-credential": "…",
    "x-amz-date": "…",
    "policy": "…",
    "x-amz-signature": "…"
  },
  "key": "acme-com/engineering/<uuid>-architecture.pdf"
}
```

**Uploading the file:** build a `multipart/form-data` POST to `url` with every
entry in `fields` as a form field, plus the file itself under the `file` field.
The presigned POST expires after 5 minutes.

**Errors**

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error":"…"}` | Missing/invalid field or unsupported content type. |
| 401 | `{"error":"Missing tenant claim (custom:tenantId)"}` | Token lacks tenant. |
| 403 | `{"error":"Not a member of department \"…\""}` | Caller can't upload to that department. |

---

## 3. Provisioning — create a new tenant (self-service)

`POST /signup` (no auth)

**Request body**

```json
{
  "name": "Acme Corp",
  "adminEmail": "admin@acme.com",
  "domain": "acme.com"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Organization display name. |
| `adminEmail` | string | yes | Must be on the claimed `domain`. |
| `domain` | string | yes | The email domain that maps to this tenant. |

**Response `201`**

```json
{ "domain": "acme.com", "tenantId": "acme-com", "status": "PENDING" }
```

**Errors**

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error":"adminEmail must be on the claimed domain"}` | Domain mismatch. |
| 400 | `{"error":"…"}` | Missing field. |
| 409 | `{"error":"Domain already registered"}` | Duplicate domain. |
| 500 | `{"error":"Internal server error"}` | Unexpected failure. |

---

## 4. Provisioning — confirm a tenant (activate)

`POST /confirm` (no auth)

**Request body**

```json
{ "domain": "acme.com", "token": "<verification-token>" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `domain` | string | yes | The domain to activate. |
| `token` | string | yes | The verification token emailed (or logged) at sign-up. |

**Response `200`**

```json
{ "domain": "acme.com", "tenantId": "acme-com", "status": "ACTIVE" }
```

**Errors**

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error":"Invalid or expired verification token"}` | Bad token. |
| 400 | `{"error":"domain and token are required"}` | Missing field. |
| 500 | `{"error":"Internal server error"}` | Unexpected failure. |

**State machine:** `PENDING` → `ACTIVE` (on confirm). A `PENDING` tenant does
**not** resolve in pre-token-generation, so its users cannot log in until the
admin confirms.

---

## Known gaps (not yet exposed as APIs)

- **User management** — there is no endpoint to create users or assign them to
  a department/org. Users are provisioned via Google Workspace federation
  (departments = Workspace groups) or as native Cognito users. A
  "create user / assign department" API is a future story.
- **SES email** — the verification link is currently logged to CloudWatch, not
  emailed, until a verified `FROM_EMAIL` is configured.
- **Cognito Hosted UI domain** — not yet configured; Google federation via the
  Hosted UI needs a domain. Native username/password auth works without one.
