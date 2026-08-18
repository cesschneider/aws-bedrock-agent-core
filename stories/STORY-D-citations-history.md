# STORY-D — Citations & History (both-dimension re-check, tenant-scoped store)

**Status:** Draft (awaiting @po validation)
**Spec:** `docs/multi-tenant-design.md` §4.4, §4.5
**Phase:** D
**Branch:** `feature/multi-tenant-d-citations-history`

## User Story

As a user, citation links and conversation history must be scoped to my tenant, so I can't mint links to another tenant's documents or see another tenant's history.

## Background

Today `presignCitation` re-checks department only, and conversation history is keyed by `userId` alone. This story adds tenant scoping to both.

## Acceptance Criteria

- [ ] `presignCitation` re-validates **both** `tenantId` and `department` at link-generation time.
- [ ] A citation for another tenant's document is silently omitted (not errored).
- [ ] Conversation history is scoped by `tenantId` (partition key becomes `tenantId#userId`, or `tenantId` is added as a stored attribute + GSI).
- [ ] `appendTurn` / `getRecentTurns` include `tenantId` in the key/query.

## Error Scenarios

| # | Condition | Expected |
|---|---|---|
| E1 | Citation tenant ≠ user tenant | Omit citation (return null) |
| E2 | Citation department not in user's departments | Omit citation (existing behavior) |
| E3 | History query without tenant | Reject / no results (fail closed) |
| E4 | Cross-tenant history read attempt | No results (keyed by tenant) |

## Implementation Details

- **Files:** `lambda/chat-handler/citations.ts`, `lambda/common/conversation-store.ts`, `lib/constructs/conversation-history.ts`.
- **History key:** change partition key to `tenantId#userId` (composite) OR add `tenantId` attribute + GSI. Prefer composite key (no GSI cost).
- **Citation:** `s3UriToKey` already yields the key; parse `tenantId` from the first segment and compare to the user's tenant.

## Test Cases

- TC-D.1 — citation tenant mismatch → `null`.
- TC-D.2 — citation department mismatch → `null` (existing).
- TC-D.3 — matching tenant + department → presigned URL returned.
- TC-D.4 — `appendTurn` writes with `tenantId#userId` key.
- TC-D.5 — `getRecentTurns` for tenant A does not return tenant B's turns.

## Traceability

- Spec §4.4 (both-dimension citation re-check), §4.5 (tenant-scoped history).
