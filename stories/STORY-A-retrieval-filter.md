# STORY-A — Retrieval Filter Fix (mandatory tenant + department vector-level filter)

**Status:** Draft (awaiting @po validation)
**Spec:** `docs/multi-tenant-design.md` §4.3, §6
**Phase:** A (security-critical — do first)
**Branch:** `feature/multi-tenant-a-retrieval-filter`

## User Story

As a platform operator, I need retrieval to be constrained by a **mandatory, vector-level filter** on `tenantId` and `department`, so a user can never retrieve another tenant's or another department's documents — even if the model is prompted to ignore scoping.

## Background / Gap

Today `agent-invoke.ts` passes `departments` as a `promptSessionAttributes` string that the agent instruction never references. The filter is **decorative, not enforced**. This story makes it a hard retrieval constraint.

## Acceptance Criteria

- [ ] `invokeAgent` builds a `bedrock` namespace session attribute with a `RetrievalFilter` (`andAll`) of `FilterAttribute` for `tenantId` (equals) and `department` (in-list).
- [ ] The filter is **always present** on every `InvokeAgent` call — no code path omits it.
- [ ] `tenantId` is derived from the verified JWT (via `AuthResult`), never from the request body or user input.
- [ ] Missing/empty `tenantId` **fails closed** — the invocation throws before calling Bedrock (no retrieval).
- [ ] `department` list always includes the tenant's `org-wide` scope.
- [ ] `AGENT_INSTRUCTION` in `lib/constructs/agent.ts` is updated to reference the enforced filter (defense-in-depth, not the primary mechanism).

## Error Scenarios

| # | Condition | Expected |
|---|---|---|
| E1 | `tenantId` missing/empty in `AuthResult` | Throw `TenantScopeError`; no Bedrock call |
| E2 | `departments` empty after adding `org-wide` | Throw; no Bedrock call (fail closed) |
| E3 | Filter shape malformed (missing `andAll`) | Throw at construction; no Bedrock call |
| E4 | Bedrock rejects the filter (API error) | Propagate error; do not retry without the filter |

## Implementation Details

- **Files:** `lambda/chat-handler/agent-invoke.ts`, `lambda/chat-handler/jwt-auth.ts` (add `tenantId` to `AuthResult`), `lambda/common/auth.ts` (add `ORG_WIDE` + tenant helpers), `lib/constructs/agent.ts` (instruction).
- **Key types:** add `tenantId: string` to `AuthResult`; add `buildRetrievalFilter(tenantId, departments)` returning the `bedrock` namespace attribute.
- **Wire format:** `sessionState.sessionAttributes` → `bedrock` → `knowledgeBaseConfigurations` → `retrievalConfiguration` → `vectorSearchConfiguration` → `filter` (`andAll` of `FilterAttribute`). Verify exact shape against the current `@aws-sdk/client-bedrock-agent-runtime` types before finalizing.

## Test Cases

- TC-A.1 — filter present on a normal invoke (assert `andAll` has `tenantId` + `department` attributes).
- TC-A.2 — `tenantId` empty → throws, no `client.send` called.
- TC-A.3 — `departments` only `org-wide` → filter still built, `department` in-list contains `org-wide`.
- TC-A.4 — `org-wide` always appended even when user has zero departments.
- TC-A.5 — `tenantId` value equals the JWT-derived value (not request body).

## Traceability

- Spec §4.3 (mandatory filter), §6 (tenant from verified JWT, fail closed).
- Fixes the "decorative filter" gap flagged in the design doc.
