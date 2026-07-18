# TODOS

Deferred scope from plan reviews — not blocking current phases, tracked for later.

## From CEO review (2026-07-18, via /autoplan)

### Slack/Teams bot as primary interface
- **What:** Deliver the chat experience inside Slack/Teams instead of (or in addition to) a standalone web UI.
- **Why:** CEO review's top adoption-risk finding — a tool people have to remember to open loses to habitual tools like Slack search. Meeting users where they already work materially improves adoption odds.
- **Pros:** Higher expected adoption; no context-switch cost; can reuse the same `chat-handler`/AgentCore backend.
- **Cons:** New integration surface (Slack/Teams app, bot auth, event subscriptions); doubles the number of front-ends to maintain.
- **Context:** Web chat UI (Phase 3) ships first. If the Phase 3 pilot's adoption metric stalls, this is the most likely fix — revisit then rather than building both up front.
- **Effort estimate:** M (human) → S with CC+gstack.
- **Priority:** P2
- **Depends on:** Phase 3 pilot data (don't build blind).

### Automated RAG answer-quality eval suite
- **What:** A golden Q&A regression set that runs against the AgentCore agent to catch answer-quality regressions (e.g. after a model version bump or KB re-ingestion).
- **Why:** Without this, quality regressions are only caught by users noticing bad answers — by then trust is already damaged.
- **Pros:** Catches regressions before users do; enables safer iteration on prompts/models.
- **Cons:** New test infrastructure; requires curating a representative Q&A set per department, which takes real effort to build and maintain.
- **Context:** Best built once there's real ingested content and real usage patterns to draw golden questions from — premature before Phase 3 pilot.
- **Effort estimate:** M (human) → S with CC+gstack.
- **Priority:** P2
- **Depends on:** Phase 3 pilot (need real usage to build a meaningful golden set).

### Feature-flagged / canary Nova Pro model version bumps
- **What:** Gate Bedrock model version upgrades behind a feature flag or canary rollout instead of a flat cutover.
- **Why:** Model behavior can shift meaningfully between versions; a flat cutover risks a silent quality regression across all users at once.
- **Pros:** Safer upgrade path; can roll back a bad model version without a full deploy.
- **Cons:** Added operational complexity for a small user base (<50 users) where blast radius of a bad upgrade is already limited.
- **Context:** Not urgent at launch scale — revisit once the answer-quality eval suite (above) exists, since canarying without a way to measure quality delta is of limited value.
- **Effort estimate:** S (human) → S with CC+gstack.
- **Priority:** P3
- **Depends on:** Automated eval suite (above), otherwise there's no signal to canary against.

## From Eng review (2026-07-18, via /autoplan)

### Malware/content scanning on uploaded documents
- **What:** Scan uploaded files (especially to the `company-wide` bucket, open to all authenticated employees) for malware/malicious content before they're eligible for Knowledge Base ingestion — e.g. Amazon GuardDuty S3 Malware Protection, or a custom ClamAV Lambda layer.
- **Why:** A malicious or compromised file uploaded to a department or company-wide bucket gets ingested and becomes readable by everyone with access — ties directly into the already-flagged prompt-injection risk (Section 4.4). No scanning exists in the v1 spec.
- **Pros:** Closes a real content-integrity gap; GuardDuty option is AWS-managed with low ops overhead.
- **Cons:** New AWS service/infra to enable and pay for; adds a step to the ingestion pipeline (latency, another failure mode to handle).
- **Context:** Deferred for v1 given the launch scale (<50 users, presumably trusted employees) — revisit if the tool opens to more users or the threat model changes (e.g. external contractors gain upload access).
- **Effort estimate:** S (human) → S with CC+gstack (GuardDuty option); M (human) → S-M with CC+gstack (custom ClamAV option).
- **Priority:** P2
- **Depends on:** None — can be added independently at any phase.
