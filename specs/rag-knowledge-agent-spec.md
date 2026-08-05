# Internal RAG Knowledge Agent — Specification (Draft v1)

## 1. Summary

An internal, ChatGPT-style assistant that answers employee questions **strictly from company documents**. Employees upload files (scoped to their department) to S3; ingestion is triggered automatically and synced into a Bedrock Knowledge Base; a chat agent (built on Amazon Bedrock Agents, the managed/serverless offering) answers queries grounded only in documents the requesting user's department is allowed to see.

Fully serverless: S3, Lambda, API Gateway, Cognito, Bedrock (Knowledge Base + Agents). No always-on compute, no containers/ECR — this is a prototype/PoC and container-based hosting (including Amazon Bedrock AgentCore Runtime, which requires deploying agent code as a container image) is explicitly out of scope.

## 2. Goals / Non-Goals

**Goals**
- Answers are grounded only in ingested company documents (no un-sourced model knowledge).
- Department-scoped visibility: a user only gets answers from documents their department(s) can access.
- Upload → searchable knowledge with no manual ingestion step.
- Standard office document support: PDF, DOCX, TXT, PPTX.

**Non-Goals (this draft)**
- Fine-grained per-document or per-user ACLs (only department-level scoping).
- Real-time collaborative editing or document versioning workflows.
- Non-office structured data sources (databases, CSV, Confluence/wiki exports) — deferred.
- Multi-tenant (multiple companies) support.

**Content policy (CEO review addition):** department-level scoping means every member of a department can see every document uploaded to it. This is NOT equivalent to per-role sensitivity — a department-wide bucket is unsuitable for PII, legal, or compensation/payroll content, since e.g. a recruiter in `dept-hr` would gain access to a comp spreadsheet meant only for HR leadership. Employees and admins must be instructed that PII/legal/comp material should not be uploaded to department or company-wide buckets under this v1 access model. Revisit if this proves too restrictive in practice.

## 3. Architecture Overview

```mermaid
flowchart TD
    subgraph Auth
        GWS[Google Workspace<br/>OIDC IdP + groups]
        COG[Cognito User Pool<br/>federated, department claims]
        GWS -- OIDC federation --> COG
    end

    subgraph Upload Path
        FE[Web Chat/Upload UI]
        S3IN[S3: raw-documents bucket<br/>prefix: department/filename]
        LUP[Lambda: upload-handler<br/>presigned URL + validation]
    end

    subgraph Ingestion Path
        S3EVT[S3 ObjectCreated Event]
        LSYNC[Lambda: kb-sync-trigger<br/>StartIngestionJob]
        KB[Bedrock Knowledge Base<br/>chunking + embeddings]
        VS[(Vector Store<br/>Amazon S3 Vectors)]
    end

    subgraph Query Path
        APIGW[HTTP API<br/>auth + upload endpoints]
        LCHAT[Lambda Function URL<br/>chat-handler, RESPONSE_STREAM]
        AC[Bedrock Agent<br/>Nova Pro]
        DDB[(DynamoDB<br/>conversation history)]
    end

    FE -- auth --> COG
    FE -- upload request --> LUP
    LUP -- presigned PUT --> S3IN
    S3IN --> S3EVT --> LSYNC --> KB
    KB --> VS

    FE -- question + JWT --> LCHAT
    LCHAT -- validates dept claim --> COG
    LCHAT -- retrieve+generate<br/>metadata filter: department --> AC
    AC --> KB
    AC -- session/short-term state --> AC
    LCHAT -- persist turn --> DDB
    AC -- streamed grounded answer --> LCHAT --> FE
```

## 4. Components

### 4.1 Identity — Cognito federated with Google Workspace
- Cognito User Pool is configured with **Google Workspace as an OIDC identity provider** — no native Cognito users/passwords; employees authenticate via their existing Google Workspace login.
- Department membership comes from **Google Workspace groups**, mapped into Cognito group claims at federation time (one Workspace group ↔ one department, e.g. `dept-engineering@company.com` → `dept-engineering`).
- A reserved **`company-wide`** department value is implicitly granted to every authenticated user (see 4.2/4.4), independent of Workspace group membership.
- A user may belong to multiple department groups; the ID token carries all of them, and access is the **union** of those departments plus `company-wide`.
- ID token issued to the frontend carries department claim(s), used both for upload tagging and query-time filtering.

### 4.2 Upload path
- Frontend requests a **presigned S3 upload URL** from `upload-handler` Lambda, passing the target department (validated against the caller's federated group membership — a user cannot upload into a department they don't belong to, except `company-wide`, which anyone may upload to).
- Object key convention: `s3://raw-documents/{department}/{uuid}-{original-filename}`, where `{department}` may be `company-wide`.
- `upload-handler` also writes/validates S3 object metadata (`x-amz-meta-department`) redundantly, since the Knowledge Base ingestion needs a reliable, tamper-resistant field to filter on later (prefix alone is fine for filtering client-side, but Bedrock KB metadata filtering works off a metadata JSON sidecar or object tags — see 4.3).
- **Upload validation (Eng review addition):** `upload-handler` validates file content-type by sniffing actual file bytes, not just the declared extension/MIME type (a `.pdf` extension with disguised content should be rejected). Reject empty (0-byte) files. Malformed/corrupted files (e.g. password-protected PDFs Bedrock KB can't parse) should fail cleanly at ingestion (see 4.3 failure handling), not silently disappear.
- **Presigned URL enforcement (Eng review addition):** the presigned upload URL must bake in content-length and content-type conditions (S3 presigned POST policy conditions, not a bare presigned PUT) so a client can't upload an unexpectedly large file or a different content-type than what was validated at URL-issuance time.
- **CEO review flag — architecture alternative not yet evaluated:** Bedrock Knowledge Base has a native Google Drive data source connector. Since identity is already federated to Google Workspace, folder-per-department Drive sync could replace this entire upload-handler + presigned URL + metadata sidecar subsystem. This would reverse the original "employees upload to S3" requirement, so it is **not** adopted by default — but per CEO review decision, it should be spiked and compared against the S3 pipeline before Phase 1 implementation locks in the upload architecture. See open item in Section 7.

### 4.3 Ingestion path
- S3 `ObjectCreated` event → `kb-sync-trigger` Lambda.
- Lambda writes a `<filename>.metadata.json` sidecar (Bedrock KB convention) containing `{"metadataAttributes": {"department": "<dept>"}}` alongside the object, then calls `StartIngestionJob` on the Bedrock Knowledge Base data source.
- Bedrock KB handles **semantic chunking**, embedding (**Amazon Titan Embeddings**), and upsert into the vector store (**Amazon S3 Vectors** — chosen over OpenSearch Serverless to avoid its OCU cost floor at this launch scale; confirm current Bedrock KB support level for S3 Vectors before implementation, since it's a newer integration).
- Batching consideration: bursty uploads could trigger many overlapping `StartIngestionJob` calls — Bedrock KB queues/serializes ingestion jobs per data source, but we should debounce (e.g. SQS + short delay window) if upload volume is high. Not a concern at the confirmed launch scale (< 500 docs, < 50 users) — revisit if volume grows.
- **Idempotency (Eng review addition):** S3 event delivery is at-least-once — `kb-sync-trigger` must dedupe on `(object-key, etag)` before calling `StartIngestionJob`, otherwise duplicate `ObjectCreated` deliveries trigger redundant ingestion jobs for the same object.
- **Stuck-job handling (Eng review addition):** Bedrock KB ingestion jobs can remain `IN_PROGRESS` indefinitely under certain parse failure conditions. The DLQ path (below) only triggers on an explicit failure status — add a timeout/circuit-breaker check (e.g. a scheduled Lambda checking job age) so a hung job doesn't silently block that document forever.
- **Failure handling**: on parse/ingestion failure, retry with backoff; if retries are exhausted, route to a dead-letter queue (SQS DLQ) for manual review. Exact retry count/backoff and whether the uploader or an ops channel gets notified on DLQ landing is still to be defined during implementation (see [questionnaire](./rag-knowledge-agent-questionnaire.md), Q4).

### 4.4 Query path
- Frontend sends question + Cognito ID token to a **Lambda Function URL** (`chat-handler`, invoke mode `RESPONSE_STREAM`) — not the HTTP API, which handles only upload/auth. The Function URL streams the answer back token-by-token.
- `chat-handler` validates the JWT itself (no built-in API Gateway JWT authorizer on Function URLs) and extracts department claim(s). **(Eng review addition):** since JWT validation lives in business logic rather than a gateway layer, it must cache the Cognito JWKS with a TTL and explicitly handle expired tokens, clock skew, wrong-audience, and malformed-claim cases — these need dedicated unit tests (see Eng review Test Plan). A short ID-token TTL is also the practical mitigation for a user whose Workspace group access is revoked mid-session (the query path doesn't re-check group membership live, unlike citation links — see below).
- `chat-handler` invokes the Bedrock Agent (**Amazon Nova Pro**, managed serverless Bedrock Agents — not AgentCore Runtime, which requires container/ECR hosting and is out of scope for this serverless-only prototype), passing the user's department(s) **plus `company-wide`** as a **retrieval metadata filter** (`department IN (user's departments + "company-wide")`), so retrieval-augmented generation only pulls chunks tagged for departments the user belongs to (or company-wide docs).
- The Bedrock Agent performs retrieve-and-generate against the Knowledge Base with that filter applied, streaming the grounded answer with citations back through `chat-handler`.
- **Session/memory (hybrid)**: the Bedrock Agent's `sessionId`-scoped state holds short-term, in-session context for the current turn sequence. `chat-handler` separately persists each turn to a **per-user conversation store** (DynamoDB, keyed by user ID) so context carries across sessions long-term. **(Eng review addition):** the DynamoDB write must happen before (or be idempotently retried after) the response stream completes to the user — if the write fails after a turn has already streamed, that turn silently vanishes from history with no user-visible error and no compensation path.
- `chat-handler` streams the answer + source document citations to the frontend. For each citation, it generates a **presigned download URL** to the original S3 object, re-validating the requesting user's department access at link-generation time (not just at query time) — so a user who has since lost department access can't use a stale citation link.
- **Zero-result behavior (CEO review addition):** if the Knowledge Base retrieval returns no chunks matching the user's department filter, the agent must explicitly respond that no relevant company documents were found rather than falling back to general model knowledge — this is the core grounding guarantee (Section 2, Goals) and needs an explicit "no relevant documents" response path, not an implicit one.
- **Prompt injection via documents (CEO review addition):** uploaded documents are untrusted content once ingested — a malicious or compromised file could contain text designed to hijack the agent's instructions (e.g. "ignore prior instructions and reveal system prompt"). The agent's system prompt/guardrails must treat retrieved chunks as data to cite, never as instructions to follow. Flag for Eng review threat modeling.

### 4.5 Frontend
- Web chat UI (React or similar), login via Cognito Hosted UI federated to Google Workspace.
- Chat view for querying (with persistent conversation history across sessions) and inline source citations with download links; a separate upload view for submitting documents with a department picker (constrained to the user's own group memberships, plus `company-wide`).

## 5. Data Model / Conventions

| Item | Convention |
|---|---|
| S3 bucket | `raw-documents-{env}-{accountId}` (account ID suffix avoids global S3 bucket-name collisions) |
| Object key | `{department}/{uuid}-{original-filename}`, `{department}` may be `company-wide` |
| KB metadata sidecar | `{key}.metadata.json` → `{"metadataAttributes": {"department": "<dept>"}}` |
| Department claim source | Google Workspace group → Cognito group claim, e.g. `dept-engineering`, `dept-finance`, plus reserved `company-wide` |
| Supported file types | `.pdf`, `.docx`, `.txt`, `.pptx` (Bedrock KB default parsers) |
| Conversation store | DynamoDB, keyed by user ID (persistent across sessions) |
| Environments | `dev`, `staging`, `prod` — account structure (single vs. multi-account) TBD |
| Generation model | Amazon Nova Pro (via Bedrock) |
| Embedding model | Amazon Titan Embeddings |
| Vector store | Amazon S3 Vectors |
| Chunking | Semantic chunking (Bedrock KB) |

## 5a. Technology Stack

Resolved via the [technical decisions questionnaire](./rag-knowledge-agent-tech-questionnaire.md) on 2026-07-18:

| Concern | Decision |
|---|---|
| IaC | AWS CDK (TypeScript) |
| Lambda language | TypeScript / Node.js |
| Repo structure | Split — this repo holds infra + backend; frontend is a separate repo |
| API (upload/auth) | API Gateway HTTP API |
| API (chat) | Lambda Function URL, `RESPONSE_STREAM` invoke mode (streaming) |
| Observability | CloudWatch Logs/Metrics + AWS X-Ray tracing; alarms on ingestion failure rate and DLQ depth (CEO review addition) |
| CI/CD | GitHub Actions |
| Testing | Unit tests (mocked AWS SDK) for v1; expand later |
| Secrets | SSM Parameter Store (SecureString) |
| Rate limiting | Default API Gateway/account limits only for v1 |
| Agent session/memory | Hybrid — Bedrock Agent's native sessionId state for short-term, DynamoDB for long-term cross-session persistence |

## 6. Security Considerations
- All access to S3 and the Knowledge Base is via Lambda execution roles — no direct client access to S3 or Bedrock.
- Presigned URLs (both upload and citation download links) are short-lived and scoped to a single key; citation download links are re-validated against current department access at generation time, not cached from query time.
- Department claim used for filtering must come from a verified JWT (API Gateway JWT authorizer, backed by Google Workspace OIDC federation), never a client-supplied field.
- Users cannot upload into a department they aren't a member of, except the reserved `company-wide` department (enforced server-side in `upload-handler`, not just client-side UI).
- A user with zero department groups still gets `company-wide` access only — no special-case handling needed beyond that.

## 7. Open Questions — Resolved

All items from the original open-questions list were answered via the [questionnaire](./rag-knowledge-agent-questionnaire.md) on 2026-07-18 and are reflected in the sections above (identity/federation in 4.1, company-wide docs in 4.2/4.4, multi-department union in 4.1/4.4, ingestion retry/DLQ in 4.3, conversation persistence in 4.4, citations in 4.4, environments in 5, launch scale below).

All technical implementation questions were likewise answered via the [technical decisions questionnaire](./rag-knowledge-agent-tech-questionnaire.md) on 2026-07-18 and are reflected in section 5a and throughout section 4.

**Remaining sub-decisions** (not blocking, to resolve during implementation):
- Google Workspace OIDC app registration details and exact Workspace-group-to-department naming convention.
- DLQ retry count/backoff, and whether the uploader or an ops channel is notified when a document lands in the DLQ.
- Conversation history retention/TTL policy in DynamoDB.
- **Resolved (2026-07-18):** Account structure is **separate AWS accounts per environment** (dev, staging, prod each isolated), not a single shared account. GitHub Actions deploys to each via its own OIDC role/environment. See `docs/deployment-setup.md` for the setup guide.
- Document growth rate and query volume were not estimated — launch scale is confirmed small (< 500 docs, < 50 users), which keeps vector store and Lambda sizing low-risk for v1, but growth-rate estimates would help set autoscaling/cost alarms.
- **Resolved (2026-07-19):** the Bedrock Agent (classic, not AgentCore Runtime — this project is serverless-only, no containers/ECR) uses its native `sessionId` for short-term in-turn state; `chat-handler` writes each turn to DynamoDB before completing the response stream (write-before-stream), giving long-term cross-session persistence. Implemented in `lib/constructs/agent.ts` and `lambda/chat-handler/`.
- Define the dev/staging/prod GitHub Actions promotion flow (auto-deploy vs. manual approval gate before prod).

**Blocking spikes (from CEO review, 2026-07-18) — resolve before Phase 1 architecture locks:**
1. **S3 Vectors validation** — confirm current Bedrock Knowledge Base support level and retrieval quality/latency for Amazon S3 Vectors as a backend. This has been flagged repeatedly as unconfirmed; do not treat it as settled until validated hands-on. If it proves immature, fall back to OpenSearch Serverless (accept the cost floor) rather than discovering this mid-Phase-1.
2. **S3 upload vs. Google Drive native sync** — spike Bedrock KB's native Google Drive data source connector against the specced S3 upload-handler pipeline. If a folder-per-department Drive structure can enforce the same department-tagging guarantees, it may eliminate the upload-handler/presigned-URL/metadata-sidecar subsystem entirely. Decide before building the upload path.

**Organizational gaps (from CEO review, 2026-07-18):**
- No named content owner per department responsible for upload quality/freshness — add one before Phase 2 launch, or answers will silently go stale and erode trust.
- No pilot/adoption gate — recommend naming one pilot department and one adoption metric (e.g. "% of dept questions answered without escalating to a human") before rolling the frontend out to all departments (see Section 9, Phase 3).

## 8. Launch Scale (confirmed)

- Documents at launch: **< 500**
- Active users: **< 50**
- Document sizes: **typical office docs**, no large-document (500+ page) handling needed for v1.

This keeps S3 Vectors storage and Lambda concurrency requirements modest for the initial launch; revisit sizing if adoption grows materially beyond these numbers.

**10x capacity note (Eng review addition):** at 5,000 docs / 500 users, two things need explicit attention that aren't a concern at launch scale: (1) `chat-handler`'s Lambda Function URL has a 15-minute execution cap and default concurrency limits — 500 concurrent streaming chat sessions could hit reserved-concurrency throttling; plan for provisioned concurrency or a queueing layer before scaling past launch scale. (2) Re-validate S3 Vectors and DynamoDB read/write capacity assumptions at that volume. Not blocking for v1 — revisit explicitly before any rollout beyond the Phase 3 pilot department.

## 9. Suggested Phases

0. **Phase 0 — Spikes (CEO review gate)**: validate S3 Vectors on Bedrock KB; compare S3 upload pipeline vs. Google Drive native connector. Resolve both before committing to Phase 1 infra.
1. **Phase 1 — Core pipeline**: S3 bucket, single-department (no filtering) Knowledge Base, ingestion Lambda, basic chat Lambda + Bedrock Agent, no auth (internal testing only).
2. **Phase 2 — Identity & scoping**: Cognito federated with Google Workspace, department + `company-wide` claims, metadata tagging, retrieval-time filtering (union of departments + company-wide).
3. **Phase 3 — Frontend & pilot**: web chat + upload UI, gated citation download links, persistent cross-session conversation history. Launch to one pilot department first against a named adoption metric before rolling out company-wide.
4. **Phase 4 — Hardening**: ingestion retry/DLQ with notification, monitoring/alarms, cost tuning, dev/staging/prod environment setup.

## 10. CEO Review — Required Outputs (2026-07-18, via /autoplan, SELECTIVE EXPANSION mode)

**NOT in scope** (considered, explicitly deferred):
- Slack/Teams bot as primary interface (CEO review's top adoption-risk suggestion) — real scope, new integration surface, not free. Deferred to TODOS.md; revisit if web-UI adoption stalls at the Phase 3 pilot gate.
- Automated RAG answer-quality eval suite (golden Q&A regression set) — meaningful new test infra, not a spec-only addition. Deferred to TODOS.md.
- Feature-flagged/canary model version bumps for Nova Pro — operational nicety, not blocking for v1. Deferred to TODOS.md.
- Per-document/per-user ACLs — explicitly a non-goal per Section 2; the content-policy note (Section 2) is the mitigation for v1.

**What already exists:** This is a greenfield repository (`aws-bedrock-agent-core`) — no existing code, services, or infrastructure to leverage or duplicate. All sub-problems are net-new builds.

**Dream state delta:**
```
CURRENT STATE                          THIS PLAN                                12-MONTH IDEAL
No internal search/RAG tool   --->     Department-scoped RAG chat, one   --->   Company-wide adoption across all
exists; employees search              pilot department, S3-vector-backed        departments, Slack/Teams-native
shared drives manually                 KB, web chat UI                          entry point, automated answer-quality
                                                                                 eval gating deploys, per-document
                                                                                 sensitivity tagging if department-
                                                                                 level ACL proves too coarse
```
This plan is a direct, unambiguous step toward that 12-month state — it does not paint the system into a corner, since the Slack/Teams front-end and finer ACLs are additive, not replacements for what's specced.

**Error & Rescue Registry:** deferred to Eng review (Phase 3) — Lambda function boundaries aren't concrete enough yet at spec stage to enumerate exception classes meaningfully; this is a required Eng-phase output instead.

**Failure Modes Registry:**

| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|---|---|---|---|---|---|
| Ingestion (`kb-sync-trigger`) | `StartIngestionJob` fails/parse error | Y (retry+DLQ, per spec 4.3) | Eng review TBD | N/A (async) | Alarm added (this review) |
| Query (`chat-handler`) | KB returns zero chunks | **N — GAP, fixed this review** (4.4 addition) | Eng review TBD | Was: nothing specified → Now: explicit "no relevant documents" message | Eng review TBD |
| Query (`chat-handler`) | Malicious document attempts prompt injection | **N — GAP, flagged this review** (4.4 addition) | Eng review TBD | Depends on guardrail design | Eng review TBD |
| Citation link | User's department access revoked between query and citation click | Y (per spec 4.4, re-validated at link-gen time) | Eng review TBD | "Access denied" (implied) | Eng review TBD |

No CRITICAL GAP rows remain unaddressed by this review (both flagged gaps got a spec fix in-line above); remaining "Eng review TBD" cells are expected — this document is pre-implementation.

**Completion Summary:**
```
+====================================================================+
|            MEGA PLAN REVIEW — CEO PHASE COMPLETION SUMMARY         |
+====================================================================+
| Mode selected        | SELECTIVE EXPANSION                          |
| Premise gate         | PASSED — user confirmed Q Business already   |
|                       | considered and rejected                      |
| Section 1  (Arch)    | 1 issue found (rollback posture on bad       |
|                       | ingestion) — deferred to Eng review          |
| Section 2  (Errors)  | Deferred to Eng review (no code yet)         |
| Section 3  (Security)| 2 issues found, fixed in-line (content       |
|                       | policy, prompt injection guardrail)          |
| Section 4  (Data/UX) | 1 edge case gap found, fixed in-line         |
|                       | (zero-result response)                       |
| Section 5  (Quality) | N/A — no code yet                            |
| Section 6  (Tests)   | Deferred to Eng review                       |
| Section 7  (Perf)    | No issues found                              |
| Section 8  (Observ)  | 1 gap found, fixed in-line (ingestion/DLQ    |
|                       | alarms)                                      |
| Section 9  (Deploy)  | No new issues                                |
| Section 10 (Future)  | Reversibility: 4/5, 2 spikes gate Phase 1    |
| Section 11 (Design)  | SKIPPED (no UI scope)                        |
+--------------------------------------------------------------------+
| NOT in scope         | written (4 items)                            |
| What already exists  | written (greenfield — nothing to reuse)      |
| Dream state delta    | written                                      |
| Failure modes        | 4 total, 0 unaddressed CRITICAL GAPS         |
| Scope proposals      | 2 surfaced (D2 content policy, D3 Drive vs   |
|                       | S3 spike) — both resolved by user            |
| Outside voice        | Claude subagent only (Codex not installed)   |
| Unresolved decisions | 0                                             |
+====================================================================+
```

## Implementation Tasks (CEO phase)
- [ ] **T1 (P1, human: ~1 day / CC: ~1 hour) — Ingestion** — Spike: validate Amazon S3 Vectors support/quality in Bedrock Knowledge Base
  - Surfaced by: CEO review, Section 10 / 6-month regret scenario
  - Files: N/A (spike, pre-infra)
  - Verify: manual validation against a sample document set
- [ ] **T2 (P1, human: ~1 day / CC: ~1 hour) — Upload path** — Spike: compare S3 upload-handler pipeline vs. Bedrock KB native Google Drive connector
  - Surfaced by: CEO review D3
  - Files: N/A (spike, pre-infra)
  - Verify: folder-per-department Drive sync test vs. current presigned-URL flow
- [ ] **T3 (P2, human: ~2h / CC: ~15min) — Query path** — Implement explicit "no relevant documents found" response when KB retrieval returns zero chunks
  - Surfaced by: CEO review Section 4
  - Files: chat-handler Lambda (once implemented)
  - Verify: query with a department filter that matches no ingested docs
- [x] **T4 (P1, human: ~1 day / CC: ~2h) — Query path** — Design agent guardrails so retrieved document chunks are treated as data to cite, never as instructions to follow
  - Surfaced by: CEO review Section 3 (prompt injection)
  - Files: `lib/constructs/agent.ts` (Bedrock Agent instruction + `test/agent.test.ts`)
  - Verify: `test/agent.test.ts` asserts the prompt-injection guardrail text is present in the synthesized template; adversarial test document with an injected instruction still TBD as a live end-to-end test
- [ ] **T5 (P2, human: ~1h / CC: ~10min) — Observability** — Add CloudWatch alarms on ingestion failure rate and DLQ depth
  - Surfaced by: CEO review Section 8
  - Files: CDK observability stack (once implemented)
  - Verify: trigger a synthetic ingestion failure, confirm alarm fires
- [ ] **T6 (P2, human: ~1h / CC: ~10min) — Process** — Name a content owner per department (upload quality/freshness) and one pilot department + adoption metric for Phase 3 rollout
  - Surfaced by: CEO review Section 5 (adoption risk)
  - Files: N/A (organizational decision, not code)
  - Verify: documented before Phase 3 kickoff

## 11. Eng Review — Required Outputs (2026-07-18, via /autoplan)

**Architecture (system dependency graph):**
```
                    ┌─────────────────┐
                    │ Google Workspace │
                    │  (OIDC + groups) │
                    └────────┬─────────┘
                             │ federation
                    ┌────────▼─────────┐
                    │  Cognito User Pool│
                    └────────┬─────────┘
                             │ JWT (ID token)
        ┌────────────────────┼─────────────────────┐
        │                    │                      │
┌───────▼────────┐  ┌────────▼─────────┐   ┌───────▼────────┐
│  upload-handler │  │   chat-handler    │   │  (citation link │
│  (HTTP API)     │  │ (Lambda Fn URL,   │   │   generation,   │
│                 │  │  RESPONSE_STREAM) │   │   inside chat-  │
└───────┬─────────┘  └────────┬──────────┘   │   handler)      │
        │ presigned PUT       │                └─────────────────┘
┌───────▼─────────┐           │ retrieve+generate
│  S3: raw-docs    │           │ (dept filter)
└───────┬─────────┘   ┌───────▼──────────┐
        │ ObjectCreated│ Bedrock Agent     │
┌───────▼─────────┐    │  (Nova Pro)       │
│ kb-sync-trigger  │    └───────┬──────────┘
│ (dedup on        │            │
│  key+etag — new) │    ┌───────▼──────────┐
└───────┬─────────┘    │ Bedrock Knowledge  │
        │ StartIngestion│ Base (semantic     │
        │               │ chunking, Titan    │
┌───────▼─────────┐    │ embeddings)         │
│ SQS DLQ (on      │    └───────┬──────────┘
│ retry exhaustion)│            │
└──────────────────┘   ┌───────▼──────────┐
                        │ Amazon S3 Vectors │
                        └──────────────────┘
                                 │
                        ┌────────▼─────────┐
                        │ DynamoDB (per-user│
                        │ conversation      │
                        │ history)          │
                        └──────────────────┘
```
Coupling concerns (per Eng subagent review): `chat-handler` couples JWT validation + department-filter logic + Bedrock Agent invocation + DynamoDB persistence into one Lambda — acceptable at this scale, but the JWT-validation-in-business-logic coupling (noted in 4.4) is the one worth watching as the system grows.

**Test Plan** — written to `~/.gstack/projects/cesschneider-aws-bedrock-agent-core/cesar-main-eng-review-test-plan-20260718.md` (see file for full coverage diagram). Summary of gaps identified (all now reflected in spec sections above):
- JWT edge cases: expired, wrong issuer/audience, malformed claims, clock skew — unit tests required, none specified before this review.
- S3 event duplicate delivery — needs a dedup test (same object-key+etag delivered twice → single ingestion job).
- Ingestion partial failure (some chunks succeed, some fail) and stuck `IN_PROGRESS` jobs — needs both a functional test and a monitoring check.
- Upload validation: 0-byte file, disguised content-type, corrupted/password-protected document — needs rejection tests.
- Citation re-validation at link-generation time — needs a test for "access revoked between query and citation click."
- Zero-result and prompt-injection response paths (added this review) — needs explicit tests before Phase 1 is considered done.

**Failure Modes Registry:**

| Codepath | Failure Mode | Rescued? | Test? | User Sees? | Logged? |
|---|---|---|---|---|---|
| `kb-sync-trigger` | Duplicate S3 event → double ingestion | **Fixed this review** (dedup key) | TBD (Phase 1) | N/A (async) | TBD |
| `kb-sync-trigger` | Ingestion job stuck `IN_PROGRESS` | **Fixed this review** (timeout check) | TBD (Phase 1) | Delayed availability, no error | TBD |
| `chat-handler` | JWT expired/malformed/wrong-audience | **Fixed this review** (JWKS cache + validation) | TBD (Phase 1) | "Please sign in again" (implied) | TBD |
| `chat-handler` | DynamoDB write fails after stream completes | **Fixed this review** (write-before-complete) | TBD (Phase 1) | Was: silent data loss → Now: must not lose the turn | TBD |
| `upload-handler` | Oversized/wrong-content-type upload past presigned URL | **Fixed this review** (POST policy conditions) | TBD (Phase 1) | Upload rejected | TBD |

No CRITICAL GAP rows remain unaddressed — all identified gaps got a spec-level fix this review; "TBD (Phase 1)" reflects that concrete test code doesn't exist yet at spec stage, which is expected.

**NOT in scope** (Eng review, in addition to CEO review's list):
- Malware/content scanning on uploads — deferred to TODOS.md (new infra, not a spec-only fix).
- Per-user rate limiting on the chat endpoint — reaffirmed as default-limits-only for v1 (see decision log).

**What already exists:** Same as CEO review finding — greenfield repository, nothing to reuse or duplicate.

**Worktree parallelization strategy:** Not yet applicable — this is a pre-implementation spec with no code to parallelize. Revisit once Phase 1 implementation begins (upload path, ingestion path, and query path are largely independent Lambda functions and could plausibly be built in parallel worktrees once the spike decisions in Section 7 land).

**Completion Summary:**
```
+====================================================================+
|                 ENG REVIEW — COMPLETION SUMMARY                    |
+====================================================================+
| Scope                | Held as-is (no reduction)                    |
| Architecture Review  | 4 issues found, all fixed in-line             |
| Code Quality Review  | N/A — no code yet                             |
| Test Review          | Diagram + test plan artifact written,         |
|                       | 6 gap categories identified                   |
| Performance Review   | 1 issue found (10x capacity), fixed in-line   |
| NOT in scope         | written (2 items)                             |
| What already exists  | written (greenfield)                          |
| TODOS.md updates     | 1 item added (malware scanning)               |
| Failure modes        | 5 total, 0 unaddressed CRITICAL GAPS          |
| Outside voice        | Claude subagent only (Codex not installed)    |
| Parallelization      | N/A pre-implementation                        |
| Unresolved decisions | 0                                              |
+====================================================================+
```

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|-----------|-----------|----------|
| 1 | CEO | Mode: SELECTIVE EXPANSION | Mechanical | P6 (autoplan default for feature enhancement) | Existing baseline scope held, expansions surfaced individually | — |
| 2 | CEO | Premise gate: proceed with custom build | User Challenge (resolved) | N/A — human judgment | User confirmed Amazon Q Business already considered and rejected | Reconsidering Q Business now |
| 3 | CEO | Content-sensitivity policy note added | Taste (user decided) | P1 completeness | User chose cheapest fix over reopening ACL design or accepting risk silently | Per-document ACLs now; accept risk as-is |
| 4 | CEO | Google Drive vs. S3 upload: gated as blocking spike, not decided either way | Taste (user decided) | N/A — user judgment | User chose to evaluate rather than commit to either architecture | Keep S3 as specced without evaluation |
| 5 | CEO | Zero-result response path added | Mechanical | P1 completeness | Core grounding guarantee gap, no reasonable disagreement | — |
| 6 | CEO | Prompt-injection guardrail note added | Mechanical | P1 completeness | Real threat surface, no reasonable disagreement | — |
| 7 | CEO | Ingestion/DLQ CloudWatch alarms added | Mechanical | P2 (in blast radius, no new infra) | Cheap, uses already-planned CloudWatch | — |
| 8 | CEO | Pilot department + adoption metric added | Mechanical | P2 (in blast radius, no new infra) | Cheap process addition, addresses adoption risk | — |
| 9 | CEO | Slack/Teams bot deferred to TODOS.md | Mechanical | P3 (outside blast radius) | New integration surface, real scope, not free | Adding to v1 scope now |
| 10 | CEO | Answer-quality eval suite deferred to TODOS.md | Mechanical | P3 (outside blast radius) | New test infra, needs real usage data first | Building now, pre-pilot |
| 11 | CEO | Feature-flagged model bumps deferred to TODOS.md | Mechanical | P3 (outside blast radius) | Operational nicety, not blocking v1 | Building now |
| 12 | Eng | S3 event dedup (object-key+etag) added | Mechanical | P5 explicit fix | At-least-once delivery correctness gap, no disagreement possible | — |
| 13 | Eng | Stuck-ingestion-job timeout added | Mechanical | P1 completeness | Silent-failure gap, no disagreement possible | — |
| 14 | Eng | JWKS caching + JWT edge case handling added | Mechanical | P5 explicit fix | Auth correctness gap, no disagreement possible | — |
| 15 | Eng | DynamoDB write-before-stream-complete added | Mechanical | P1 completeness | Silent data-loss gap, no disagreement possible | — |
| 16 | Eng | Upload content-type sniffing + presigned POST conditions added | Mechanical | P5 explicit fix | Input validation gap, no disagreement possible | — |
| 17 | Eng | 10x capacity note added | Mechanical | P1 completeness | Scaling gap flagged for future, no disagreement possible | — |
| 18 | Eng | Malware/content scanning deferred to TODOS.md | Taste (user decided) | P3 (new infra required) | User accepted risk at launch scale over adding new AWS service now | Add GuardDuty/ClamAV now |
| 19 | Eng | Rate limiting reaffirmed as default-only | Taste (user decided) | N/A — re-litigation of prior decision | User confirmed original tech-questionnaire decision stands against new DoS/cost angle | Add per-user throttling now |
| 20 | DX | Phase exited — no external developer-facing surface | Mechanical | Skill's own applicability gate | Internal ops tool; maintainability already covered by Eng review | Forcing external-product DX methodology onto internal infra |

