# Document Registry API — UI Integration Spec

This document is the contract for the frontend (Lovable UI) to implement the
document management features. It covers the new document list/get/delete
endpoints and the tag support added to uploads.

---

## Base URLs (dev)

| Service | Base URL |
|---|---|
| Upload | `https://9xgzlkfq3e.execute-api.us-east-1.amazonaws.com` |
| Documents | `https://w1a89nq56l.execute-api.us-east-1.amazonaws.com` |
| Chat | `https://fubcenfu74tcomihthllz7lpaq0wjpfw.lambda-url.us-east-1.on.aws/` |

> The Documents base URL is emitted as the CloudFormation stack output
> `DocumentsApiUrl` (current dev value shown above). It changes on redeploy —
> re-fetch it via the command in "Discovering the Documents URL" below.

---

## Authentication

Every documents endpoint requires the Cognito **ID token** in the
`Authorization` header:

```
Authorization: Bearer <id-token>
```

The same token used for chat and upload. The backend enforces tenant +
department isolation from the token claims — the UI must NOT filter by
tenant/department itself; it just sends the token and renders what comes back.

---

## 1. List documents

`GET /documents`

Returns every document the caller may access (their departments + `org-wide`),
most recent first.

**Response `200`**

```json
{
  "documents": [
    {
      "documentId": "11111111-1111-1111-1111-111111111111",
      "tenantId": "acme-com",
      "department": "dept-engineering",
      "filename": "report.pdf",
      "contentType": "application/pdf",
      "sizeBytes": 1024,
      "tags": ["finance", "q3"],
      "status": "INDEXED",
      "uploadedBy": "dev-tester",
      "uploadedAt": "2026-08-21T00:00:00.000Z",
      "indexedAt": "2026-08-21T00:00:05.000Z"
    }
  ]
}
```

**Field reference**

| Field | Type | Notes |
|---|---|---|
| `documentId` | string | Stable id; use for get/delete |
| `tenantId` | string | The org the document belongs to |
| `department` | string | Human-facing department name |
| `filename` | string | Original filename |
| `contentType` | string | MIME type |
| `sizeBytes` | number | Size in bytes (0 until indexed) |
| `tags` | string[] | User-supplied tags (may be empty) |
| `status` | string | `PENDING` \| `INDEXED` \| `FAILED` |
| `uploadedBy` | string | Username of the uploader |
| `uploadedAt` | string | ISO 8601 timestamp |
| `indexedAt` | string \| undefined | ISO 8601, set once indexed |

**Errors**

| Status | Body | Meaning |
|---|---|---|
| `401` | `{"error":"…"}` | Missing/invalid/expired token |

---

## 2. Get a single document

`GET /documents/{documentId}`

Returns the full detail for one document (same shape as a list entry, but a
single object, not wrapped in `documents`).

**Response `200`**

```json
{
  "documentId": "11111111-1111-1111-1111-111111111111",
  "tenantId": "acme-com",
  "department": "dept-engineering",
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 1024,
  "tags": ["finance", "q3"],
  "status": "INDEXED",
  "uploadedBy": "dev-tester",
  "uploadedAt": "2026-08-21T00:00:00.000Z",
  "indexedAt": "2026-08-21T00:00:05.000Z"
}
```

**Errors**

| Status | Body | Meaning |
|---|---|---|
| `404` | `{"error":"Document not found"}` | No such document in the caller's tenant |
| `403` | `{"error":"Not a member of the document's department"}` | Document exists but caller lacks access |

---

## 3. Delete a document

`DELETE /documents/{documentId}`

Removes the document (S3 object + metadata + registry record). It is no longer
retrievable via chat after the next ingestion job.

**Response `200`**

```json
{ "deleted": true, "documentId": "11111111-1111-1111-1111-111111111111" }
```

**Errors** — same `404` / `403` semantics as `GET /documents/{id}`.

---

## 4. Upload with tags (updated)

`POST /uploads`

The upload request body now accepts an optional `tags` array.

**Request body**

```json
{
  "department": "dept-engineering",
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "tags": ["finance", "q3"]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `department` | string | yes | Human-facing department name, or `org-wide` |
| `filename` | string | yes | Original filename |
| `contentType` | string | yes | `application/pdf`, `.docx`, `text/plain`, `.pptx` |
| `tags` | string[] | no | Max 20 tags, 64 chars each; trimmed + deduped |

**Response `200`** (now includes `documentId`)

```json
{
  "url": "https://raw-documents-dev-….s3.amazonaws.com/",
  "fields": { "key": "…", "Content-Type": "…", "…": "…" },
  "key": "acme-com/dept-engineering/<uuid>-report.pdf",
  "documentId": "11111111-1111-1111-1111-111111111111"
}
```

The multipart POST to `url` is unchanged (all `fields` as form fields + the
file under `file`).

**Errors** (new tag validation)

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error":"tags must be an array of strings"}` | `tags` is not an array |
| `400` | `{"error":"too many tags (max 20)"}` | More than 20 tags |
| `400` | `{"error":"tag \"…\" exceeds 64 characters"}` | A tag is too long |

---

## UI implementation notes

- **Documents screen**: add a new tab/screen that calls `GET /documents` and
  renders a table/list. Show `filename`, `department`, `sizeBytes` (formatted),
  `tags` (as chips), `status` (badge), and `uploadedAt` (formatted date/time).
- **Detail view**: clicking a row calls `GET /documents/{id}` (or reuse the
  list entry) and shows the full detail.
- **Delete**: a delete action calls `DELETE /documents/{id}`, then refreshes
  the list. Confirm before deleting.
- **Upload tags**: add a tag input (comma-separated or chip input) to the
  upload form; send the array in the `tags` field.
- **Status handling**: a freshly uploaded document shows `PENDING` until
  ingestion completes (usually seconds). Poll `GET /documents` or re-fetch
  after a short delay to reflect `INDEXED`.
- **Errors**: surface backend error bodies (`{"error":"…"}`) verbatim, as with
  the existing upload/chat screens.

---

## Discovering the Documents URL

The Documents API base URL is a CloudFormation stack output named
`DocumentsApiUrl`. To fetch it:

```bash
aws cloudformation describe-stacks \
  --stack-name RagKnowledgeAgent-dev \
  --profile eworks-dev \
  --query "Stacks[0].Outputs[?OutputKey=='DocumentsApiUrl'].OutputValue" \
  --output text
```

The backend owner will provide the current value for the UI config.
