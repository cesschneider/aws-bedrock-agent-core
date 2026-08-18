# STORY-B2 — Tenant Registry + Self-Service Provisioning

**Status:** Draft (awaiting @po validation)
**Spec:** `docs/multi-tenant-design.md` §4.1, Phase B2, §9 (resolved decisions)
**Phase:** B2
**Branch:** `feature/multi-tenant-b2-provisioning`

## User Story

As a new organization, I can self-serve provision my tenant by signing up and confirming my admin email, so I don't need an ops/back-office action to onboard.

## Background

Tenant provisioning is self-service. This story builds the tenant registry (DynamoDB) and the sign-up → admin-email-confirmation flow.

## Acceptance Criteria

- [ ] `TenantRegistry` DynamoDB table exists (domain → tenantId + metadata: name, status, plan).
- [ ] Provisioning endpoint accepts a sign-up (org name, admin email, claimed domain).
- [ ] A verification link is emailed to the admin email (on the claimed domain).
- [ ] The domain→tenant mapping is **activated only after** the admin confirms the link.
- [ ] Unconfirmed tenants are `PENDING` and do **not** resolve in `pre-token-generation` (fail closed).
- [ ] `pre-token-generation` reads from this registry (wired in STORY-B).

## Error Scenarios

| # | Condition | Expected |
|---|---|---|
| E1 | Admin email domain ≠ claimed domain | Reject sign-up (400) |
| E2 | Domain already registered | Reject (409 conflict) |
| E3 | Verification link expired/invalid | Reject (400); tenant stays PENDING |
| E4 | Confirm for a non-existent tenant | Reject (404) |
| E5 | Email send fails | Sign-up fails cleanly; tenant not activated |

## Implementation Details

- **Files:** `lib/constructs/tenant-registry.ts`, `lambda/tenant-provisioning/` (sign-up + confirm handlers), `lib/constructs/tenant-provisioning-api.ts`.
- **Email:** SES (or existing email infra) for the verification link. Link carries a signed, expiring token.
- **Status machine:** `PENDING` → `ACTIVE` (on confirm) → `SUSPENDED` (future).

## Test Cases

- TC-B2.1 — valid sign-up → tenant `PENDING`, email sent.
- TC-B2.2 — admin email domain mismatch → 400.
- TC-B2.3 — duplicate domain → 409.
- TC-B2.4 — confirm with valid token → tenant `ACTIVE`.
- TC-B2.5 — confirm with expired token → 400, stays `PENDING`.
- TC-B2.6 — `pre-token-generation` does not resolve a `PENDING` tenant (fail closed).

## Traceability

- Spec Phase B2, §9 (self-service + admin email confirmation).
- Resolved decisions #3 (self-service) and #4 (admin email confirmation).
