# Document Registry API

The document registry is the source of truth for every uploaded document. A
record is written at upload time (status `PENDING`) and updated at ingestion
time (size + status `INDEXED`). It carries the permission scope (tenant +
department), tags, timestamps, and ingestion status that the S3 object alone
cannot expose.

## Endpoints

All endpoints are behind the same Cognito JWT authorizer as the upload API.
Send the ID token as `Authorization: Bearer <id-token>`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/documents` | List documents the caller may access |
| `GET` | `/documents/{documentId}` | Full detail for a single document |
| `DELETE` | `/documents/{documentId}` | Remove a document (registry + S3 object) |

### GET /documents

Returns every document in the caller's tenant that belongs to a department the
caller is a member of (union of their departments + `org-wide`), most recent
first.

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

### GET /documents/{documentId}

Returns the full detail for a single document.

**Errors**

| Status | Body | Meaning |
|---|---|---|
| `404` | `{"error":"Document not found"}` | No such document in the caller's tenant |
| `403` | `{"error":"Not a member of the document's department"}` | Document exists but caller lacks department access |

### DELETE /documents/{documentId}

Deletes the S3 object, its `.metadata.json` sidecar, and the registry record.
The document is no longer retrievable via chat once the next ingestion job
runs.

**Response `200`**

```json
{ "deleted": true, "documentId": "11111111-1111-1111-1111-111111111111" }
```

**Errors** — same `404` / `403` semantics as `GET /documents/{id}`.

## Tags

Uploads accept an optional `tags` array (max 20 tags, 64 chars each). Tags are
stored on the registry record and written into the Bedrock KB metadata sidecar
as `metadataAttributes.tags`, so they can be used for finer-grained filtering
and classification. Tags are normalized (trimmed, deduped) at upload time.

## Data model

DynamoDB table `DocumentRegistryTable`:

- Partition key: `tenantId` (a query can never cross tenant boundaries)
- Sort key: `documentId` (the UUID embedded in the S3 object key)

Fields: `department` (tenant-namespaced), `plainDepartment`, `filename`,
`contentType`, `sizeBytes`, `tags`, `status` (`PENDING` | `INDEXED` |
`FAILED`), `s3Key`, `uploadedBy`, `uploadedAt`, `indexedAt`.
