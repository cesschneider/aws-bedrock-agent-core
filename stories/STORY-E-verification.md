# STORY-E — End-to-End Multi-Tenant Verification

**Status:** Draft (awaiting @po validation)
**Spec:** `docs/multi-tenant-design.md` Phase E
**Phase:** E
**Branch:** `feature/multi-tenant-e-verification`

## User Story

As a platform operator, I need an end-to-end test proving tenant isolation, so I can ship multi-tenancy with confidence.

## Background

All prior stories build the pieces. This story verifies the isolation guarantees hold together in a deployed environment.

## Acceptance Criteria

- [ ] Two tenants (e.g. `acme`, `globex`) each with documents in distinct departments.
- [ ] A user of tenant `acme` querying a topic that only exists in `globex` gets **zero results** (cross-tenant isolation).
- [ ] Org-wide content in `acme` is visible to **all** `acme` users (any department).
- [ ] Department content in `acme` is visible **only** to that department's users.
- [ ] Citation links for cross-tenant documents are never generated.
- [ ] Conversation history is isolated per tenant.

## Error Scenarios

| # | Condition | Expected |
|---|---|---|
| E1 | Cross-tenant query | Zero results (no fallback to general knowledge) |
| E2 | Cross-department query (same tenant) | Zero results for that department's content |
| E3 | Org-wide query from any tenant user | Results returned |
| E4 | Cross-tenant citation | No link generated |

## Implementation Details

- **Files:** `test/` (integration test script), `docs/` (verification runbook).
- **Approach:** a scripted end-to-end test (upload docs for two tenants → query as each → assert isolation), run against the `dev` environment.
- **Not a unit test** — this is a live-environment verification, documented as a runbook.

## Test Cases

- TC-E.1 — cross-tenant query returns zero results.
- TC-E.2 — org-wide content visible to all tenant users.
- TC-E.3 — department content visible only to that department.
- TC-E.4 — cross-tenant citation suppressed.
- TC-E.5 — history isolated per tenant.

## Traceability

- Spec Phase E (verification), §2 (goals: isolation, org-wide, department scoping).
