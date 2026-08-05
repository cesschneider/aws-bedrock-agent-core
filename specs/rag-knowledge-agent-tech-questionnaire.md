# Internal RAG Knowledge Agent — Technical Decisions Questionnaire

Companion to [`rag-knowledge-agent-spec.md`](./rag-knowledge-agent-spec.md) and [`rag-knowledge-agent-questionnaire.md`](./rag-knowledge-agent-questionnaire.md) (product/access decisions — already resolved). This questionnaire covers **implementation-level technical decisions**: IaC, runtime, models, data stores, and operational tooling.

**Status: answered (2026-07-18).**

---

### T1. Infrastructure-as-Code tool
How should infrastructure be defined and deployed?

- [x] AWS CDK (TypeScript)

Notes:

---

### T2. Lambda runtime / language
Which language should the Lambda functions (`upload-handler`, `kb-sync-trigger`, `chat-handler`, etc.) be written in?

- [x] TypeScript / Node.js

Notes: Matches CDK-in-TypeScript.

---

### T3. Repository structure
How should this repo be organized as the implementation grows?

- [x] Split repos — infra/backend in this repo, frontend in a separate repo

Notes: This repo (`aws-bedrock-agent-core`) holds CDK infra + Lambda functions; frontend gets its own repo (name/location TBD).

---

### T4. Bedrock foundation model (generation)
Which model should the agent use for answer generation?

- [x] Amazon Nova — **Nova Pro**

Notes: Balanced accuracy/cost/latency for RAG-style Q&A with citations.

---

### T5. Embedding model
Which embedding model should the Knowledge Base use for vectorization?

- [x] Amazon Titan Embeddings (Bedrock default)

Notes:

---

### T6. Vector store
Bedrock Knowledge Base needs a vector store backend.

- [x] Amazon S3 Vectors (native S3 vector store for Bedrock Knowledge Base)

Notes: Chosen over OpenSearch Serverless — avoids the OCU cost floor, fits the confirmed small launch scale (< 500 docs, < 50 users). Confirm current Bedrock Knowledge Base support/limits for S3 Vectors during implementation, since it's a newer integration than OpenSearch Serverless.

---

### T7. Chunking strategy
How should documents be split into chunks before embedding?

- [x] Semantic chunking (Bedrock KB's semantic chunking option)

Notes: Prioritizes retrieval quality over the simpler fixed-size default; adds some ingestion processing cost/time.

---

### T8. API Gateway type
- [x] HTTP API (cheaper, simpler, sufficient for JWT authorizer + Lambda proxy)

Notes: Used for upload/auth endpoints. Streaming chat responses (T9) are delivered via a separate mechanism — see T9.

---

### T9. Chat response delivery
Should chat answers stream token-by-token, or return as a single complete response?

- [x] Streaming

Notes: Delivered via a **Lambda Function URL with response streaming** (`InvokeMode: RESPONSE_STREAM`) dedicated to `chat-handler`, rather than a WebSocket API. Upload/auth endpoints stay behind the HTTP API (T8); the chat endpoint is invoked directly via its Function URL.

---

### T10. Observability
What's needed for logging, metrics, and tracing?

- [x] CloudWatch + AWS X-Ray tracing across the request path

Notes:

---

### T11. CI/CD
How should deployments to dev/staging/prod be automated?

- [x] GitHub Actions

Notes: Manual approval gate before prod, and dev/staging/prod branch or environment strategy, still to be defined during implementation.

---

### T12. Testing strategy
What level of automated testing is expected before this ships?

- [x] Unit tests only (Lambda handler logic, mocked AWS SDK calls)

Notes: Expand to integration/E2E later if needed.

---

### T13. Secrets management
Any secrets beyond what Cognito/IAM roles already handle (e.g. Google Workspace OIDC client secret)?

- [x] SSM Parameter Store (SecureString)

Notes: Chosen over Secrets Manager — lower cost, acceptable given a small number of static secrets and no rotation requirement identified.

---

### T14. Rate limiting / abuse protection
Should the chat API have throttling beyond default API Gateway limits?

- [x] Default API Gateway throttling only (account-level limits)

Notes: Not a concern at confirmed launch scale (< 50 users); revisit if usage grows.

---

### T15. AgentCore session/memory implementation
Bedrock AgentCore has built-in session/memory primitives — should we use those directly, or roll our own on DynamoDB (per the persistent-conversation-history decision already made)?

- [x] Hybrid — AgentCore for short-term session state, DynamoDB for long-term persistence

Notes: AgentCore's native session/memory handles in-session (short-term) context during a single conversation turn sequence; DynamoDB (keyed by user ID) remains the durable store for cross-session history per the product spec's decision. Exact handoff/sync mechanism between the two is an implementation detail to work out in Phase 2/3.

---

## Additional open items (optional)

- Confirm Bedrock Knowledge Base's current support level for S3 Vectors as a backend (T6) before committing infra code — it's newer than the OpenSearch Serverless integration.
- Define the dev/staging/prod GitHub Actions promotion flow (auto-deploy vs. manual approval) (T11).
- Define the exact AgentCore-session-to-DynamoDB handoff mechanism (T15) — likely needs a short implementation spike.

