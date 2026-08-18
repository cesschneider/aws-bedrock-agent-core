# Multi-Tenant Design — RAG Knowledge Agent

**Status:** Draft (proposed extension to `specs/rag-knowledge-agent-spec.md`)
**Date:** 2026-08-18
**Scope:** Extends the single-company, department-scoped v1 into a multi-tenant system supporting multiple organizations, each with multiple users and departments, plus per-tenant org-wide content.

---

## 1. Summary

The current system models **one company** with **departments only** (see `specs/rag-knowledge-agent-spec.md`, Section 2 explicitly lists "Multi-tenant (multiple companies) support" as a non-goal). This document specifies the change to a **two-level scope**:

- **Tenant** (`tenantId`) — the hard isolation boundary. A user can *never* retrieve another tenant's documents.
- **Department** (`department`) — the soft, within-tenant governance boundary.
- **Org-wide** (`org-wide`) — a per-tenant reserved scope, replacing the single global `company-wide`, so every user of a tenant can query that tenant's org-level content.

The core guarantee is **data privacy isolation**: retrieval is always constrained by a mandatory `tenantId` filter derived from the verified JWT — never from user input, never omitted, never left to the model's discretion.

---

## 2. Goals / Non-Goals

**Goals**
- Multiple organizations (tenants) coexist in one deployment, each with its own users and departments.
- A user can only retrieve documents from their own tenant, and within it, only their departments plus the tenant's org-wide scope.
- Tenant isolation is enforced at the vector-search level (not by prompt instruction alone).
- Org-level content is queryable by every user of that tenant.

**Non-Goals (this iteration)**
- Per-document or per-user ACLs (still department-level within a tenant — see content-policy note in the parent spec, Section 2).
- Per-tenant infrastructure (separate KB/index per tenant) — deferred as an upgrade path (Section 8).
- Cross-tenant sharing or federation between tenants.
- Tenant self-service provisioning / admin UI (tenant creation is an ops/back-office action for now).

---

## 3. Scope Model

```
tenantId (hard isolation)
 └── department (soft, within tenant)
      └── documents
 └── org-wide (reserved, per-tenant — visible to all users of the tenant)
```

A user's effective access set is:

```
{ tenantId } × ( { user's departments } ∪ { org-wide } )
```

- `tenantId` is **singular and mandatory** — a user belongs to exactly one tenant.
- `department` is **plural** — a user may belong to multiple departments (union, as today).
- `org-wide` is **implicit** — every user of a tenant gets it, exactly as `company-wide` works today, but namespaced per tenant.

### Naming / namespacing

Departments are **tenant-namespaced** to avoid collisions across tenants (two tenants can both have an "engineering" department):

- Internal representation: `{tenantId}:{department}` (e.g. `acme:dept-engineering`).
- The reserved org-wide scope: `{tenantId}:org-wide`.

This namespacing is internal (claims, metadata, filters). The human-facing department name stays `dept-engineering`; the tenant prefix is added at the boundary.

---

## 4. Component Changes

### 4.1 Identity — add a tenant claim

- Each user carries a **`tenantId`** claim alongside their departments.
- **Google Workspace path:** tenant is derived from the user's email domain (or a Workspace group convention, e.g. `org-acme@…`), resolved in `pre-token-generation` and emitted as a custom claim.
- **Native/dev path:** a `tenantId` Cognito group or custom attribute (the dev test user gets a fixed dev tenant).
- Departments are emitted **tenant-namespaced** (`acme:dept-engineering`) plus the tenant's `org-wide` (`acme:org-wide`).

**Files:** `lambda/pre-token-generation/index.ts`, `lambda/common/auth.ts`.

### 4.2 Document metadata — tag both dimensions

- The metadata sidecar becomes `{"metadataAttributes": {"tenantId": "<id>", "department": "<dept>"}}`.
- S3 object key becomes `{tenantId}/{department}/{uuid}-{filename}` (extending the current `{department}/…` convention; the tenant is the first path segment).
- Both `tenantId` and `department` must be **filterable** in the vector index.

**Files:** `lambda/kb-sync-trigger/index.ts`, `lib/constructs/vector-index.ts`, `lambda/upload-handler/` (key construction).

### 4.3 Retrieval — enforce a mandatory filter (the core change)

Replace the current decorative `promptSessionAttributes` department string with an **explicit, always-applied retrieval filter**:

```
tenantId = :tenantId AND department IN (:departments)
```

- `tenantId` is **non-negotiable** — derived from the verified JWT, never from user input, never omitted. This is the data-privacy isolation guarantee.
- `department IN (...)` includes the user's departments **plus the tenant's `org-wide`**.
- The filter is applied at the **vector-search level** (Bedrock Agent retrieval configuration / bedrock-namespace session attributes), not left to the model's discretion.

> **Critical gap being fixed:** today the department filter is passed as a `promptSessionAttributes` string that the agent instruction never references — it is decorative, not enforced. This spec makes the filter a hard retrieval constraint.

**Files:** `lambda/chat-handler/agent-invoke.ts`, `lib/constructs/agent.ts` (instruction update).

### 4.4 Citation re-check — both dimensions

`presignCitation` must re-validate **`tenantId` and `department`** at link-generation time (today it checks department only). A user who lost access mid-session must not mint links to another tenant's document.

**Files:** `lambda/chat-handler/citations.ts`.

### 4.5 Conversation history — tenant-scoped

The DynamoDB conversation table must partition/scope by `tenantId` (or at minimum store it) so history is isolated per org.

**Files:** `lambda/common/conversation-store.ts`, `lib/constructs/conversation-history.ts`.

### 4.6 Upload path — tenant validation

`upload-handler` must validate that the caller's `tenantId` matches the target key prefix's tenant, in addition to the existing department check.

**Files:** `lambda/upload-handler/`, `lib/constructs/upload-api.ts`.

---

## 5. Data Model / Conventions (updated)

| Item | Current (v1) | Multi-tenant |
|---|---|---|
| Object key | `{department}/{uuid}-{filename}` | `{tenantId}/{department}/{uuid}-{filename}` |
| Metadata sidecar | `{"metadataAttributes":{"department":"<dept>"}}` | `{"metadataAttributes":{"tenantId":"<id>","department":"<dept>"}}` |
| Department claim | `dept-engineering`, `company-wide` | `acme:dept-engineering`, `acme:org-wide` |
| Reserved scope | `company-wide` (global) | `org-wide` (per-tenant) |
| Vector index filterable metadata | `department` | `tenantId`, `department` |
| Conversation store | keyed by user ID | keyed by `tenantId` + user ID |

---

## 6. Security Considerations

- `tenantId` used for filtering **must come from the verified JWT**, never a client-supplied field (same rule as the department claim today).
- The `tenantId` filter is **mandatory on every query** — a missing or empty tenant must fail closed (no retrieval), not default to "all tenants."
- Citation links re-validate both `tenantId` and `department` at generation time.
- Uploads are rejected if the caller's tenant does not match the target key prefix.
- A user with zero departments still gets only their tenant's `org-wide` scope — no cross-tenant fallback.

---

## 7. Phased Plan

### Phase A — Retrieval filter fix (security-critical, do first)
1. Add `tenantId` to filterable metadata in `vector-index.ts`.
2. Implement the mandatory `tenantId AND department IN` retrieval filter in `agent-invoke.ts`.
3. Update `AGENT_INSTRUCTION` in `agent.ts` to reference the enforced filter (defense-in-depth, not the primary mechanism).
4. Unit tests: filter is always present; missing tenant fails closed.

### Phase B — Identity & claims
5. Emit `tenantId` + tenant-namespaced departments + `org-wide` in `pre-token-generation`.
6. Extract `tenantId` in `jwt-auth.ts`; update `common/auth.ts` helpers.
7. Dev test user gets a fixed dev tenant.

### Phase C — Ingestion & metadata
8. `kb-sync-trigger` writes `{tenantId, department}` sidecar; derive both from key prefix.
9. `upload-handler` builds `{tenantId}/{department}/…` keys and validates tenant match.

### Phase D — Citations & history
10. `citations.ts` re-checks both dimensions.
11. `conversation-store` + `conversation-history` scope by tenant.

### Phase E — Verification
12. End-to-end test: two tenants, cross-tenant query returns nothing; org-wide content visible to all users of a tenant; department content visible only to that department.

---

## 8. Upgrade Path — per-tenant isolation (deferred)

The shared-KB + mandatory-filter model is the default. If a tenant's data is sensitive enough that a filter bug is unacceptable, move to **per-tenant KBs** (one KB + vector index per tenant, `tenantId` baked into the resource rather than the query). This is the "no shared fate" model — higher cost, doesn't scale to hundreds of tenants, but eliminates the shared-index blast radius. Not required for this iteration; revisit if a high-sensitivity tenant is onboarded.

---

## 9. Open Questions

- **Tenant derivation for Google Workspace:** email domain vs. explicit Workspace group convention — needs a decision before Phase B.
- **Tenant provisioning:** how tenants are created (ops action vs. self-service) — out of scope for now, but the `tenantId` claim source must be defined.
- **Bedrock Agent retrieval filter mechanism:** confirm the exact API surface (retrieval configuration vs. bedrock-namespace session attributes) for the current Bedrock Agent version before Phase A implementation.
