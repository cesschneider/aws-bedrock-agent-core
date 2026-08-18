# STORY-B — Identity & Claims (tenant claim, namespaced departments, org-wide)

**Status:** Draft (awaiting @po validation)
**Spec:** `docs/multi-tenant-design.md` §4.1, §3
**Phase:** B
**Branch:** `feature/multi-tenant-b-identity-claims`

## User Story

As a user, my ID token must carry a `tenantId` (derived from my email domain) and tenant-namespaced department claims, so downstream retrieval can scope me to my organization.

## Background

Today `pre-token-generation` emits flat department names (`dept-engineering`) plus a single global `company-wide`. This story introduces `tenantId` and tenant-namespacing.

## Acceptance Criteria

- [ ] `pre-token-generation` resolves `tenantId` from the user's **email domain** via a domain→tenant registry (DynamoDB).
- [ ] Unknown domain **fails closed** — no `tenantId` claim issued (and the token is rejected downstream).
- [ ] Departments are emitted **tenant-namespaced**: `{tenantId}:{department}`.
- [ ] The reserved scope becomes **per-tenant** `{tenantId}:org-wide` (replacing global `company-wide`).
- [ ] Native/dev users get a fixed dev tenant (e.g. `dev`).
- [ ] `jwt-auth.ts` extracts `tenantId` into `AuthResult`.
- [ ] `common/auth.ts` gains `ORG_WIDE` constant + `namespacedDepartment(tenantId, dept)` + `tenantOrgWide(tenantId)` helpers.

## Error Scenarios

| # | Condition | Expected |
|---|---|---|
| E1 | Email domain not in registry | No `tenantId` claim; token rejected downstream (fail closed) |
| E2 | Email missing from event | Throw (existing behavior preserved) |
| E3 | Registry read fails (DynamoDB error) | Fail closed — no tenant claim issued |
| E4 | Duplicate department after namespacing | Dedupe (Set semantics) |

## Implementation Details

- **Files:** `lambda/pre-token-generation/index.ts`, `lambda/pre-token-generation/google-admin-groups-fetcher.ts` (if needed), `lambda/common/auth.ts`, `lambda/chat-handler/jwt-auth.ts`.
- **Registry:** new DynamoDB table `TenantRegistry` (domain → tenantId + metadata). Construct in `lib/constructs/tenant-registry.ts`.
- **Claim name:** `custom:tenantId` (Cognito custom claim) or a `cognito:groups`-adjacent convention — decide and document.

## Test Cases

- TC-B.1 — known domain → `tenantId` emitted + namespaced departments + `{tenantId}:org-wide`.
- TC-B.2 — unknown domain → no `tenantId` claim (fail closed).
- TC-B.3 — native user → fixed dev tenant.
- TC-B.4 — `jwt-auth` extracts `tenantId` into `AuthResult`.
- TC-B.5 — namespacing dedupes duplicate departments.

## Traceability

- Spec §4.1 (email-domain derivation, fail closed), §3 (namespacing, per-tenant org-wide).
- Resolved decision #1 (email domain).
