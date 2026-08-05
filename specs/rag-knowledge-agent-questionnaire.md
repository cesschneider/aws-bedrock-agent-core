# Internal RAG Knowledge Agent — Open Questions Questionnaire

Companion to [`rag-knowledge-agent-spec.md`](./rag-knowledge-agent-spec.md). Answers here resolve the "Open Questions" section of that spec and drive Phase 2+ design decisions.

**Status: answered (2026-07-18).**

---

### Q1. Department source of truth
Where do departments and their membership actually come from?

- [x] Existing corporate IdP groups — federate directly
- [ ] HR system / existing directory (e.g. Workday, BambooHR) — should sync into Cognito groups
- [ ] No existing system — seed departments and membership manually in Cognito for v1

Notes: Federate with **Google Workspace** (OIDC). Department membership comes from Google Workspace groups, not Cognito-native groups/attributes.

---

### Q2. Company-wide / cross-department documents
Do any documents need to be visible to **all** employees regardless of department, or does every document belong to exactly one department?

- [ ] Every document belongs to exactly one department (no shared/global docs)
- [x] Need a "company-wide" category visible to everyone, in addition to department-scoped docs
- [ ] Need documents shared across a specific subset of departments (not just one, not all)

Notes: Introduces a reserved `company-wide` (or `all`) department value that every user implicitly has access to, alongside their own department(s).

---

### Q3. Multi-department users
Can a single employee belong to more than one department?

- [ ] No — one department per user
- [x] Yes — a user may belong to multiple departments and should see the **union** of those departments' documents

Notes: Retrieval-time metadata filter becomes `department IN (user's departments + "company-wide")`.

---

### Q4. Ingestion failure handling
What should happen when a document fails to ingest (parse error, `StartIngestionJob` failure, unsupported content)?

- [x] Retry, then move to a dead-letter queue for manual review if retries exhausted
- [ ] Silently retry (define max retries / backoff below) and log only
- [ ] Notify the uploader directly (email/Slack/in-app) on failure
- [ ] Notify an admin/ops channel rather than the individual uploader

Notes (retry count, backoff, notification channel, etc.): Retry + DLQ confirmed; specific retry count/backoff and whether uploader/ops gets notified on DLQ landing still to be defined during implementation.

---

### Q5. Conversation history / multi-turn context
Should the agent remember earlier turns in a conversation (multi-turn context), or is every query independent?

- [ ] Stateless — each question is independent, no memory between queries
- [ ] Session-based — remember context within a single chat session only
- [x] Persistent — remember context across sessions for a given user (longer-term memory)

Notes (expected session length, expiry/TTL, etc.): Requires a durable per-user conversation store (e.g. DynamoDB keyed by user ID, not just session ID). TTL/retention policy still to be defined.

---

### Q6. Answer citations & source access
When the agent answers, should it show/link the source document(s)? If so, what happens when a user doesn't have access to open the original file?

- [ ] No citations needed — answer text only
- [ ] Show citation (document name/snippet) but no link to open original file
- [x] Show citation with a link/download to the original file, gated by the same department access control

Notes: Source file links must be served via presigned URL (or equivalent), re-validated against the requesting user's department membership at link-generation time — not just at original query time.

---

### Q7. Environment strategy
How many AWS environments do we need from the start?

- [ ] Single environment (e.g. just prod) for v1, split later if needed
- [ ] Dev + Prod from the start
- [x] Dev + Staging + Prod from the start

Notes (account structure — single AWS account vs. multi-account, naming conventions, etc.): Three environments confirmed; account structure (single account with env-prefixed resources vs. separate AWS accounts per environment) still to be decided.

---

### Q8. Expected scale
Rough sizing helps size OpenSearch Serverless, Lambda concurrency, and cost estimates.

- Expected number of documents at launch: **Small — under 500 documents**
- Expected document growth rate (per month): _not yet specified_
- Expected number of active users: **Small — under 50 users**
- Expected query volume (queries/day, or peak queries/minute): _not yet specified_
- Any known large files or unusually large documents (e.g. 500+ page PDFs)? **No — mostly typical office docs**

---

## Additional open items (optional — flag anything not covered above)

- Google Workspace federation specifics: OIDC app registration, which Google Workspace group naming convention maps to which department.
- DLQ retry count/backoff and failure-notification recipient (uploader vs. ops) still need a decision.
- Conversation history retention/TTL policy still needs a decision.
- Account structure for dev/staging/prod (single account vs. multi-account) still needs a decision.
- Document growth rate and query volume not yet estimated — needed to size OpenSearch Serverless OCUs and Lambda concurrency.

