# Multi-Tenant E2E Verification Runbook

**Scope:** STORY-E — proves tenant isolation across the full stack (retrieval, citations, conversation history).

**Environment:** `dev` (us-east-1, profile `eworks-dev`)

## Prerequisites

1. The stack is deployed (`cdk deploy --profile eworks-dev`).
2. Two tenants are registered and ACTIVE in the TenantRegistry table:
   - `acme.com` → tenantId `acme-com`
   - `globex.com` → tenantId `globex-com`
3. Two Cognito users exist, one per tenant:
   - `alice@acme.com` (departments: `dept-engineering`, `acme-com:org-wide`)
   - `bob@globex.com` (departments: `dept-sales`, `globex-com:org-wide`)
4. Documents have been uploaded for both tenants:
   - `acme-com/dept-engineering/<uuid>-eng-report.pdf` — unique topic "Project Alpha"
   - `acme-com/company-wide/<uuid>-handbook.pdf` — topic "employee handbook"
   - `globex-com/dept-sales/<uuid>-sales-plan.pdf` — unique topic "Q3 Sales Plan"
5. The Bedrock KB ingestion job has completed for all uploaded documents.

## Test Cases

### TC-E.1 — Cross-tenant query returns zero results

1. Authenticate as `alice@acme.com`.
2. POST `/chat` with message: `"What is the Q3 Sales Plan?"`
3. **Expected:** The answer contains the zero-result message
   ("No relevant company documents were found").
4. **Why:** The retrieval filter (`tenantId = acme-com`) excludes `globex-com` documents.

### TC-E.2 — Org-wide content visible to all tenant users

1. Authenticate as `alice@acme.com`.
2. POST `/chat` with message: `"What does the employee handbook say?"`
3. **Expected:** Answer is grounded in the `company-wide` handbook document.
4. **Why:** `acme-com:org-wide` is in the `department IN (...)` list.

### TC-E.3 — Department content visible only to that department

1. Upload a doc to `acme-com/dept-finance/<uuid>-budget.pdf` (topic "budget 2026").
2. Authenticate as `alice@acme.com` (departments: `dept-engineering`, not `dept-finance`).
3. POST `/chat` with message: `"What is the budget for 2026?"`
4. **Expected:** Zero results — `dept-finance` is not in Alice's department list.
5. Authenticate as `carol@acme.com` (departments: `dept-finance`).
6. POST `/chat` with the same message.
7. **Expected:** Answer is grounded in the budget document.

### TC-E.4 — Cross-tenant citation suppressed

1. Authenticate as `alice@acme.com`.
2. If the agent somehow returns a citation with an S3 key starting `globex-com/`,
   the presignCitation function must return `null` — no download link is generated.
3. **Verification:** Inspect the response `citations` array; all URLs must point to
   keys under `acme-com/`.

### TC-E.5 — Conversation history isolated per tenant

1. Authenticate as `alice@acme.com`, send a message.
2. Query the ConversationHistory DynamoDB table with
   `partitionKey = "acme-com#alice@acme.com"`.
3. **Expected:** Only Alice's turns are returned.
4. Query with `partitionKey = "globex-com#bob@globex.com"`.
5. **Expected:** Only Bob's turns are returned. No cross-tenant leakage.

## Automated Script

An integration test script is at `test/e2e-tenant-isolation.ts`.

Run it with:

```bash
npx jest test/e2e-tenant-isolation.ts --profile eworks-dev
```

The script mocks the Bedrock Agent response to simulate cross-tenant
retrieval scenarios and asserts the isolation guarantees at the handler
level — it does not require a live deployed environment.

## Sign-off Checklist

- [ ] TC-E.1 passed
- [ ] TC-E.2 passed
- [ ] TC-E.3 passed
- [ ] TC-E.4 passed
- [ ] TC-E.5 passed
- [ ] No cross-tenant data leakage observed in any response
- [ ] No cross-tenant citation links generated