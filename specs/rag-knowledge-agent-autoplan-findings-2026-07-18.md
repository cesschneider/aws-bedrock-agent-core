# RAG Knowledge Agent — /autoplan Review Findings (2026-07-18)

Consolidated findings from the `/autoplan` review pipeline run against [`rag-knowledge-agent-spec.md`](./rag-knowledge-agent-spec.md). Covers the CEO (strategy/scope) and Eng (architecture/tests/security) phases; the DX phase exited via its own applicability gate (no external developer-facing surface — see below). All fixes below are already applied to the spec; this document is the readable audit trail of what was found and why.

**Mode:** SELECTIVE EXPANSION | **Reviewers:** Claude subagent (dual-voice; Codex unavailable — not installed on this machine) | **Verdict:** Approved as-is by user.

---

## 1. CEO Review (Strategy & Scope)

### Premise Challenge
The review's mandatory human gate asked: is a fully custom-built RAG pipeline the right problem to solve, or would Amazon Q Business (AWS's managed enterprise search/RAG product) get most of this with far less custom infrastructure? **You confirmed Q Business was already evaluated and rejected** — the review proceeded on that basis rather than re-litigating it.

### Findings

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | **Department ≠ correct sensitivity boundary.** The access model treats "department" as the right visibility boundary for every document, but never addresses content needing narrower scoping (e.g. a comp spreadsheet uploaded to `dept-hr`, visible to every HR employee including recruiters). The spec's Non-Goals section explicitly defers per-document ACLs. | Critical | **Fixed.** Added an explicit content-policy note: PII/legal/comp material must not be uploaded to department or company-wide buckets under this access model (Section 2). |
| 2 | **Architecture alternative not considered: Google Drive native connector.** Bedrock Knowledge Base has a native Google Drive data source. Since identity is already federated to Google Workspace, folder-per-department Drive sync could replace the entire upload-handler/presigned-URL/metadata-sidecar subsystem — but this reverses the original "employees upload to S3" requirement. | High (architecture) | **Gated as a blocking spike**, not decided either way — you chose to evaluate before committing (new Phase 0 in the spec). |
| 3 | **6-month regret scenario, part A:** S3 Vectors' Bedrock KB integration maturity is unvalidated, yet already locked in as the decision — the spec itself flagged this as "confirm before implementation" three times without ever actually confirming it. | High | **Elevated to a blocking Phase 0 spike** rather than a footnote; fallback to OpenSearch Serverless if S3 Vectors proves immature. |
| 4 | **6-month regret scenario, part B:** No named content owner for upload quality/freshness, and no adoption gate — the bot could go stale and lose trust before anyone notices, or simply never reach meaningful usage. | High | **Fixed.** Added content-owner-per-department requirement and a pilot-department + adoption-metric gate before company-wide rollout (Phase 3). |
| 5 | **Zero-result grounding gap.** Spec didn't specify what happens when KB retrieval returns no matching chunks — risk of falling back to general model knowledge, violating the core grounding guarantee. | Medium | **Fixed.** Added explicit "no relevant documents found" response requirement (Section 4.4). |
| 6 | **Prompt injection via uploaded documents.** No guardrail specified against a malicious/compromised document containing text designed to hijack the agent's instructions. | Medium-High | **Fixed.** Added a guardrail requirement: retrieved chunks are data to cite, never instructions to follow. |
| 7 | **No ingestion/DLQ observability.** No CloudWatch alarms named for ingestion failure rate or DLQ depth. | Low | **Fixed.** Added to the observability line item (Section 5a). |
| 8 | **Execution/adoption risk.** Four phases, three environments, a hybrid session/memory design already flagged as needing a spike, zero named owner, zero pilot — a lot of moving parts for <50 users with no proof-of-adoption checkpoint. | High | **Fixed.** Phase 3 now gates company-wide rollout on a single pilot department + named adoption metric. |

### Deferred to TODOS.md (real scope, not free)
- **Slack/Teams bot as primary interface** — the review's top adoption-risk suggestion (a tool people forget to open loses to habitual tools), but a genuinely new integration surface. Revisit if the Phase 3 pilot's adoption metric stalls.
- **Automated RAG answer-quality eval suite** — needed eventually, but best built from real usage patterns post-pilot.
- **Feature-flagged/canary Nova Pro model version bumps** — not urgent at this scale; depends on the eval suite existing first.

Full context (why/pros/cons/effort/priority) for each is in [`TODOS.md`](../TODOS.md).

---

## 2. Eng Review (Architecture, Tests, Security, Performance)

### Findings

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | **DynamoDB write silently loses turns.** If the conversation-history write fails *after* the chat response has already streamed to the user, that turn vanishes from history with no compensation path. | P1 | **Fixed.** Spec now requires write-before-stream-complete or idempotent retry. |
| 2 | **No malware/content scanning on uploads.** The `company-wide` bucket is open to any authenticated employee with zero scanning — a malicious/compromised file becomes ingested and readable by everyone (compounds the prompt-injection risk). | P1 | **Deferred to TODOS.md** — you accepted this risk at launch scale (<50 trusted employees); revisit if the user base or trust model changes. |
| 3 | **S3 event duplicate delivery.** S3's at-least-once delivery guarantee means duplicate `ObjectCreated` events will trigger `StartIngestionJob` twice for the same object — no dedup key specified. | P2 | **Fixed.** Added dedup on `(object-key, etag)` before triggering ingestion. |
| 4 | **JWT validation coupling risk.** `chat-handler` validates JWTs itself (no API Gateway authorizer on Function URLs) — any Cognito key rotation, clock skew, or claim-shape change breaks auth silently inside business logic. | P2 | **Fixed.** Added JWKS caching with TTL + explicit expiry/clock-skew/malformed-claim handling requirements, plus required unit tests. |
| 5 | **Stuck ingestion jobs.** Bedrock KB ingestion jobs can remain `IN_PROGRESS` indefinitely under certain parse failures — the DLQ only triggers on explicit failure, not a hang. | P2 | **Fixed.** Added a timeout/circuit-breaker check requirement. |
| 6 | **10x load capacity gap.** No discussion of what changes at 5,000 docs / 500 users — Lambda Function URL streaming has concurrency limits that could throttle under real growth. | P2 | **Fixed.** Added a capacity note gating re-evaluation before any rollout beyond the Phase 3 pilot. |
| 7 | **Upload validation gaps.** No content-type sniffing (vs. trusting the declared extension), no rejection of 0-byte/corrupted/password-protected files, and presigned PUT URLs don't enforce size/content-type at the S3 policy level. | P2 | **Fixed.** Added content-type sniffing, empty/corrupt-file rejection, and presigned POST policy conditions (size + content-type) to the upload path. |
| 8 | **Rate limiting reconsideration.** A single compromised/leaked token could hammer the streaming chat endpoint, driving real Bedrock/Nova Pro costs — raised against the already-locked "default limits only" decision. | P2 | **Reaffirmed as-is** — you confirmed the earlier decision stands; the boundable, easily-noticed risk at <50 users doesn't justify the added engineering cost right now. |

### Test Plan
A full coverage diagram and test plan artifact were written covering JWT edge cases, S3 event dedup, ingestion partial/stuck failures, upload validation, citation re-validation, zero-result and prompt-injection paths, and multi-department/zero-department user scenarios. See `~/.gstack/projects/cesschneider-aws-bedrock-agent-core/cesar-main-eng-review-test-plan-20260718.md`.

---

## 3. DX Review — Not Applicable

The DX review's own applicability gate asks whether the plan has an actual external developer-facing surface (an API/SDK/CLI a third party integrates with). This spec doesn't — the only "developers" are the internal team building and later operating the AWS infrastructure, and that maintainability angle is already covered by the Eng review (code organization, future worktree parallelization). Rather than force an external-product framework (competitive TTHW benchmarking against Stripe/Vercel, "magical moment" design, developer-persona roleplay) onto an internal ops tool, this phase exited gracefully per its own built-in escape valve.

---

## 4. What This Means Going Forward

**Before Phase 1 architecture locks (Phase 0 — new, added by this review):**
1. Validate Amazon S3 Vectors' current Bedrock KB support/quality — hands-on, not assumed.
2. Spike Bedrock KB's native Google Drive connector against the specced S3 upload pipeline — decide which one to build.

**Before Phase 3 rollout beyond a pilot:**
- Name one pilot department and one adoption metric.
- Name a content owner per department.

**Tracked but not blocking:** 4 items in `TODOS.md` (Slack/Teams bot, eval suite, canary model bumps, malware scanning).

**Full audit trail** of every decision (mechanical vs. taste, which principle applied, what was rejected) is in the spec's `## Decision Audit Trail` table.

