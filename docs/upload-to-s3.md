# Uploading documents to S3 to trigger Knowledge Base sync

This guide shows how to load documents into the RAG knowledge base by uploading
them directly to the raw-documents S3 bucket. Each upload **automatically**
triggers ingestion into the Bedrock Knowledge Base, so the chat agent can answer
questions from the new content within seconds to minutes — no manual sync step.

## How the auto-sync pipeline works

```
aws s3 cp file.pdf s3://raw-documents-<env>-<acct>/<department>/file.pdf
        │
        ▼
S3 ObjectCreated event
        │
        ▼
kb-sync-trigger Lambda
  ├─ deduplicates (DynamoDB, 24h TTL)
  ├─ writes <key>.metadata.json  →  {"metadataAttributes":{"department":"<department>"}}
  └─ bedrock:StartIngestionJob on the Knowledge Base data source
        │
        ▼
Bedrock Knowledge Base
  ├─ semantically chunks the document
  ├─ embeds each chunk (Titan Text Embeddings V2)
  └─ stores vectors in the S3 Vectors index
```

The department is derived from the **first path segment of the object key**, so
the key prefix *is* the department. The trigger writes the
`<key>.metadata.json` sidecar itself — you do not create it.

## Prerequisites

- The stack is deployed to the environment you're testing (e.g. `dev`).
- The `aws` CLI is installed and the `eworkslabs-dev` profile is configured
  (see `docs/deployment-setup.md`).

## 1. Find the bucket name

The bucket is named `raw-documents-<env>-<accountId>` and is exposed as a stack
output:

```bash
aws cloudformation describe-stacks \
  --stack-name RagKnowledgeAgent-dev \
  --profile eworkslabs-dev \
  --query "Stacks[0].Outputs[?OutputKey=='RawDocumentsBucket'].OutputValue" \
  --output text
```

Example: `raw-documents-dev-666637312477`. Export it for the next steps:

```bash
export RAW_DOCS_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name RagKnowledgeAgent-dev \
  --profile eworkslabs-dev \
  --query "Stacks[0].Outputs[?OutputKey=='RawDocumentsBucket'].OutputValue" \
  --output text)
```

## 2. Upload a document

The object key must be `<department>/<filename>`. Use a department the chat user
can access. The dev CLI user (`dev-tester@example.invalid`) belongs to
`dept-engineering` and always has `company-wide` access, so upload to one of
those prefixes:

```bash
# A text file is the fastest way to validate end-to-end:
echo "Our remote work policy allows employees to work from home up to 3 days per week." \
  > remote-work.txt

aws s3 cp remote-work.txt "s3://${RAW_DOCS_BUCKET}/dept-engineering/remote-work.txt" \
  --profile eworkslabs-dev
```

### Supported formats

`.pdf`, `.docx`, `.txt`, `.pptx`. Keep files under ~50 MB.

### Choosing the department prefix

| Prefix             | Who can retrieve it via chat                              |
|--------------------|-----------------------------------------------------------|
| `company-wide/`    | Every authenticated user (reserved department)           |
| `dept-engineering/`| Users in the `dept-engineering` group (e.g. the dev user)|
| `dept-finance/`    | Users in `dept-finance`                                   |

For a quick smoke test, use `company-wide/` so any logged-in user can see it.

## 3. Watch ingestion

The trigger Lambda fires within a few seconds of the upload; the Bedrock
ingestion job runs after that. Two ways to check:

**Trigger Lambda logs** (confirms the S3 event was processed and the ingestion
job was started):

```bash
aws logs tail "/aws/lambda/<kb-sync-trigger-log-group>" \
  --profile eworkslabs-dev --since 5m
```

(Find the log group name in the CloudWatch console under
`/aws/lambda/rag-knowledge-agent-dev-*`, or via
`aws lambda list-functions --profile eworkslabs-dev`.)

**Ingestion job status** (confirms the KB finished ingesting):

```bash
# Get the Knowledge Base ID and Data Source ID (CFN physical resource IDs):
aws cloudformation describe-stack-resources \
  --stack-name RagKnowledgeAgent-dev --profile eworkslabs-dev \
  --query "StackResources[?ResourceType=='AWS::Bedrock::KnowledgeBase'].PhysicalResourceId" \
  --output text

aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id <KB_ID> --data-source-id <DATA_SOURCE_ID> \
  --profile eworkslabs-dev \
  --query "ingestionJobs[0].status" --output text
```

`COMPLETE` means the document is indexed and ready to query. `STARTING` /
`IN_PROGRESS` means it's still working.

## 4. Test with the chat CLI

Once ingestion is `COMPLETE`, ask the agent about the document you uploaded:

```bash
npm run chat -- configure --profile eworkslabs-dev   # once
npm run chat -- login                                 # once
npm run chat
```

```
you> What is the remote work policy?
agent> Employees can work from home up to 3 days per week.

citations:
  - cite:...
    https://raw-documents-dev-...s3.amazonaws.com/...?presigned...
```

Open a citation URL to download the source passage the answer was grounded on.

## Notes

- **Direct-to-S3 vs the upload API.** This guide uploads straight to S3, which
  is the simplest path for testing. The production path is the presigned-POST
  API (the `upload-handler` Lambda behind API Gateway), which validates file
  types, enforces the 50 MB limit, and checks that the caller's JWT grants the
  target department. Direct S3 upload skips those checks, so keep files valid
  and reasonably sized.
- **No metadata or tags required.** The trigger derives the department from the
  key prefix and writes the `.metadata.json` sidecar for you. Don't create the
  sidecar manually — it would be skipped (keys ending in `.metadata.json` are
  ignored by the trigger to avoid loops).
- **Overwrites.** Re-uploading the same key triggers a fresh ingestion job
  (dedup is keyed on `<objectKey>#<etag>`, so a new etag from a changed file is
  processed; an identical re-upload is deduplicated).
- **Never create AWS resources via the CLI.** This guide only uploads objects
  to a bucket the stack already created — all infrastructure is managed by CDK.
