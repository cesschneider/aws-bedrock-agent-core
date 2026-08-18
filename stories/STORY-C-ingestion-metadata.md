# STORY-C — Ingestion & Metadata (tenant + department sidecar and key prefix)

**Status:** Draft (awaiting @po validation)
**Spec:** `docs/multi-tenant-design.md` §4.2, §5
**Phase:** C
**Branch:** `feature/multi-tenant-c-ingestion-metadata`

## User Story

As a document uploader, my documents must be tagged with both `tenantId` and `department` at ingestion, so retrieval can filter on both dimensions.

## Background

Today `kb-sync-trigger` writes `{department}` sidecar and derives department from the first key segment. This story adds `tenantId` and extends the key convention.

## Acceptance Criteria

- [ ] Object key convention becomes `{tenantId}/{department}/{uuid}-{filename}`.
- [ ] `kb-sync-trigger` derives both `tenantId` and `department` from the key prefix.
- [ ] Metadata sidecar becomes `{"metadataAttributes":{"tenantId":"<id>","department":"<dept>"}}`.
- [ ] `upload-handler` builds `{tenantId}/{department}/…` keys.
- [ ] `upload-handler` validates the caller's `tenantId` matches the target prefix (reject on mismatch).
- [ ] `vector-index.ts` marks both `tenantId` and `department` as filterable metadata.

## Error Scenarios

| # | Condition | Expected |
|---|---|---|
| E1 | Key missing tenant segment | `kb-sync-trigger` throws (cannot determine tenant) |
| E2 | Caller tenant ≠ target prefix tenant | `upload-handler` returns 403 |
| E3 | Sidecar write fails | Propagate; ingestion not started (existing behavior) |
| E4 | Legacy key (no tenant prefix) | Fail closed — do not ingest with a guessed tenant |

## Implementation Details

- **Files:** `lambda/kb-sync-trigger/index.ts`, `lambda/upload-handler/index.ts`, `lib/constructs/vector-index.ts`.
- **Key parsing:** `tenantId` = first segment, `department` = second segment.
- **Vector index:** add `tenantId` to filterable metadata (currently only `department` is implicitly filterable; `AMAZON_BEDROCK_TEXT` stays non-filterable).

## Test Cases

- TC-C.1 — key `acme/dept-engineering/foo.txt` → sidecar `{tenantId:"acme", department:"dept-engineering"}`.
- TC-C.2 — key missing tenant segment → throws.
- TC-C.3 — `upload-handler` builds `{tenantId}/{department}/…` key.
- TC-C.4 — caller tenant mismatch → 403.
- TC-C.5 — `vector-index` template includes `tenantId` as filterable metadata.

## Traceability

- Spec §4.2 (both dimensions), §5 (key + sidecar conventions).
