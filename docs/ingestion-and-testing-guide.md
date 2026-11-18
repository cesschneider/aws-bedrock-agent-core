# Document Ingestion & Bedrock Testing Guide

**Project:** RAG Knowledge Agent (multi-client)  
**Audience:** Developers and QA testing the document ingestion pipeline  
**Last updated:** November 2026

---

## Overview

This guide covers:
1. Uploading documents to the S3 raw-documents bucket
2. How the automatic ingestion pipeline works (S3 → Lambda → Bedrock KB)
3. Verifying documents are indexed in the Knowledge Base
4. Testing retrieval and agent responses in the AWS Bedrock Console

---

## Prerequisites

| Item | How to get it |
|------|---------------|
| AWS CLI configured with the target account profile | `aws configure --profile <client-dev>` |
| Stack deployed | `npx cdk deploy -c deployment=deployments/<client>.json` |
| Stack outputs (Bucket, KB ID, Agent ID, etc.) | `aws cloudformation describe-stacks --stack-name <stack-name> --query 'Stacks[0].Outputs'` |
| A test document (PDF, DOCX, TXT, or PPTX) | Max 50 MB |

### Get stack outputs

```bash
export AWS_PROFILE=al4n-dev
export AWS_REGION=sa-east-1

# Get all outputs
aws cloudformation describe-stacks \
  --stack-name al4n-rag-dev \
  --query 'Stacks[0].Outputs' \
  --output table

# Save key values
BUCKET=$(aws cloudformation describe-stacks --stack-name al4n-rag-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`RawDocumentsBucket`].OutputValue' --output text)

KB_ID=$(aws cloudformation describe-stacks --stack-name al4n-rag-dev \
  --query 'Stacks[0].Outputs[?contains(OutputKey, `KnowledgeBaseId`)].OutputValue' --output text)

AGENT_ID=$(aws cloudformation describe-stacks --stack-name al4n-rag-dev \
  --query 'Stacks[0].Outputs[?contains(OutputKey, `AgentId`)].OutputValue' --output text)

echo "Bucket: $BUCKET"
echo "KB ID:  $KB_ID"
echo "Agent:  $AGENT_ID"
```

---

## Step 1: Upload a Document

### Option A: Direct S3 upload (CLI — simplest for testing)

The ingestion pipeline triggers on any S3 `ObjectCreated` event. The key format is:

```
{tenantId}/{department}/{uuid}-{filename}
```

For testing, use a simple tenant and department:

```bash
# Upload a test PDF
aws s3 cp ./test-document.pdf \
  s3://$BUCKET/test-tenant/engineering/$(uuidgen)-test-document.pdf

# Or upload a text file
echo "This is a test document about cloud architecture on AWS. It covers EC2, S3, and Lambda services." | \
  aws s3 cp - s3://$BUCKET/test-tenant/engineering/$(uuidgen)-intro.txt \
  --content-type "text/plain"
```

### Option B: Via the Upload API (with JWT auth)

```bash
# 1. Get a JWT token (from Cognito login or Supabase)
TOKEN="eyJ..."

# 2. Request a presigned POST URL
curl -X POST https://<upload-api-url>/upload \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "department": "engineering",
    "filename": "test-document.pdf",
    "contentType": "application/pdf",
    "tags": ["architecture", "aws"]
  }'

# Response contains presigned POST fields:
# { "url": "https://s3...", "fields": { "key": "...", "policy": "..." } }

# 3. Upload the file directly to S3 using the presigned POST
curl -X POST "$URL" \
  -F "key=$KEY" \
  -F "policy=$POLICY" \
  -F "x-amz-signature=$SIGNATURE" \
  -F "x-amz-credential=$CREDENTIAL" \
  -F "x-amz-algorithm=AWS4-HMAC-SHA256" \
  -F "x-amz-date=$DATE" \
  -F "file=@./test-document.pdf"
```

### Supported file types

| Format | Content-Type |
|--------|-------------|
| PDF | `application/pdf` |
| Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| Text | `text/plain` |
| PowerPoint | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |

**Max size:** 50 MB

---

## Step 2: How Ingestion Works (Automatic)

You do **nothing** after upload — the pipeline is fully automated:

```
S3 ObjectCreated event
    │
    ▼
kb-sync-trigger Lambda
    │  1. Deduplicates via DynamoDB (24h TTL, handles S3 at-least-once delivery)
    │  2. Writes metadata sidecar to S3 (tenant, department, tags)
    │  3. Calls Bedrock StartIngestionJob
    │  4. Updates document registry (PENDING → INDEXED)
    ▼
Bedrock Knowledge Base
    │  1. Data source sync scans the S3 prefix
    │  2. Documents are chunked and embedded (Titan Embed v2)
    │  3. Vectors stored in S3 Vectors index
    ▼
Ready for retrieval
```

### Check ingestion status via CLI

```bash
# List recent ingestion jobs
aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id $KB_ID \
  --query 'ingestionJobSummaries[0:5].[ingestionJobName,status,startTime]' \
  --output table

# Get details of a specific job
aws bedrock-agent get-ingestion-job \
  --knowledge-base-id $KB_ID \
  --data-source-id <data-source-id> \
  --ingestion-job-id <job-id>
```

### Check the document registry (DynamoDB)

```bash
# Scan the document registry table for recent uploads
aws dynamodb scan \
  --table-name <registry-table-name> \
  --filter-expression "status = :s" \
  --expression-attribute-values '{":s":{"S":"INDEXED"}}' \
  --query 'Items[0:5].documentId.S' \
  --output table
```

---

## Step 3: Verify Content is Indexed (Bedrock Console)

### 3.1 Test Retrieval (Knowledge Base)

1. Open the **AWS Bedrock Console** → https://sa-east-1.console.aws.amazon.com/bedrock/
2. Make sure you're in the correct region (e.g., **sa-east-1**)
3. Navigate to **Knowledge bases** in the left sidebar
4. Click on the Knowledge Base (e.g., `al4n-rag-dev`)
5. Click **Test knowledge base**
6. In the test panel:
   - Select **Retrieve** or **Retrieve and generate** mode
   - Enter a query related to your uploaded document, e.g.:
     ```
     What does the document say about cloud architecture?
     ```
   - Click **Run**
7. Verify:
   - ✅ Retrieved chunks appear in the results panel
   - ✅ Citations reference your uploaded document
   - ✅ The answer is grounded in the document content (not hallucinated)

### 3.2 Test the Agent (Bedrock Agents)

1. In the Bedrock Console, go to **Agents**
2. Click on the agent (e.g., `al4n-rag-dev`)
3. Click **Test** (or open the test panel)
4. If no alias is selected, select the `dev` alias
5. Enter a test message:
   ```
   What cloud architecture services are described in the documents?
   ```
6. Verify:
   - ✅ The agent responds with content from your document
   - ✅ Citations are included in the response
   - ✅ If no relevant documents exist, the agent says so (zero-result path)

### 3.3 Test via CLI (Bedrock Retrieve)

```bash
# Direct retrieval from the Knowledge Base
aws bedrock-agent-runtime retrieve \
  --knowledge-base-id $KB_ID \
  --retrieval-query '{"text": "What does the document say about cloud architecture?"}' \
  --query 'retrievalResults[0:3].content.text' \
  --output text
```

### 3.4 Test via CLI (Agent Invoke)

```bash
# Invoke the agent directly
aws bedrock-agent-runtime invoke-agent \
  --agent-id $AGENT_ID \
  --agent-alias-id <alias-id> \
  --session-id "$(uuidgen)" \
  --input-text "What cloud architecture services are described?" \
  --query 'completion' \
  --output text
```

---

## Step 4: Test the Chat API Endpoint

The stack exposes a Lambda Function URL for the chat endpoint:

```bash
CHAT_URL=$(aws cloudformation describe-stacks --stack-name al4n-rag-dev \
  --query 'Stacks[0].Outputs[?OutputKey==`ChatHandlerFunctionUrl`].OutputValue' --output text)

# You need a valid JWT from Cognito or Supabase
TOKEN="eyJ..."

# Send a chat message
curl -X POST "$CHAT_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What cloud architecture services are described in the documents?",
    "departments": ["engineering"]
  }' | jq .
```

**Expected response:**
```json
{
  "sessionId": "uuid-here",
  "answer": "Based on the company documents, the cloud architecture covers EC2, S3, and Lambda services...",
  "citations": [
    {
      "referenceId": "1",
      "url": "https://s3.sa-east-1.amazonaws.com/...presigned-url...",
      "contentType": "text/plain"
    }
  ]
}
```

---

## Troubleshooting

### Document not appearing in retrieval

| Check | Command |
|-------|---------|
| File uploaded to S3? | `aws s3 ls s3://$BUCKET/test-tenant/engineering/` |
| Ingestion job succeeded? | `aws bedrock-agent list-ingestion-jobs --knowledge-base-id $KB_ID` |
| Lambda triggered? | Check CloudWatch logs for `kb-sync-trigger` |
| Document registry updated? | `aws dynamodb scan --table-name <registry-table>` |
| Data source sync? | In Bedrock Console → KB → Data sources → Sync |

### Agent returns "no relevant documents"

- The tenant/department filter is applied at the **vector search level** — documents uploaded under `test-tenant/engineering/` are only retrievable when the session attributes include `tenantId=test-tenant` and `department=engineering`.
- For console testing without auth, use the **Retrieve** mode (no filter) to confirm the document is indexed.
- For API testing, ensure your JWT contains the correct tenant and department claims.

### SSM parameter errors on deploy

If deploying to a new account, pass a placeholder secret:
```bash
npx cdk deploy -c deployment=deployments/<client>.json \
  -c google-client-secret=placeholder
```

### Bedrock model access

Ensure the Bedrock model is enabled in the target account:
- **AWS Console** → Bedrock → Model access → Enable `Amazon Nova Pro` and `Titan Embed Text v2`

---

## Quick Reference: End-to-End Test Script

```bash
#!/bin/bash
set -euo pipefail

export AWS_PROFILE=al4n-dev
export AWS_REGION=sa-east-1

STACK="al4n-rag-dev"
BUCKET=$(aws cloudformation describe-stacks --stack-name $STACK \
  --query 'Stacks[0].Outputs[?OutputKey==`RawDocumentsBucket`].OutputValue' --output text)
KB_ID=$(aws cloudformation describe-stacks --stack-name $STACK \
  --query 'Stacks[0].Outputs[?contains(OutputKey, `KnowledgeBaseId`)].OutputValue' --output text)

echo "=== Uploading test document ==="
KEY="test-tenant/engineering/$(uuidgen)-test.txt"
echo "AWS EC2 provides scalable virtual servers. S3 offers object storage. Lambda runs serverless functions." | \
  aws s3 cp - "s3://$BUCKET/$KEY" --content-type "text/plain"
echo "Uploaded: s3://$BUCKET/$KEY"

echo "=== Waiting for ingestion (60s) ==="
sleep 60

echo "=== Checking ingestion jobs ==="
aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id $KB_ID \
  --query 'ingestionJobSummaries[0:3].[ingestionJobName,status]' \
  --output table

echo "=== Testing retrieval ==="
aws bedrock-agent-runtime retrieve \
  --knowledge-base-id $KB_ID \
  --retrieval-query '{"text": "What AWS services are described?"}' \
  --query 'retrievalResults[0:3].content.text' \
  --output text

echo "=== Done ==="
```

---

## Reference: Stack Outputs

| Output Key | Description |
|------------|-------------|
| `RawDocumentsBucket` | S3 bucket for document uploads |
| `ChatHandlerFunctionUrl` | Lambda Function URL for chat endpoint |
| `CognitoUserPoolId` | Cognito User Pool ID |
| `CognitoClientId` | Cognito App Client ID |
| `KnowledgeBaseKnowledgeBaseId...` | Bedrock Knowledge Base ID |
| `RagAgentAgentId...` | Bedrock Agent ID |
| `RagAgentAgentAliasId...` | Agent Alias ID |
| `UploadApiUploadApiUrl...` | API Gateway URL for uploads |
| `DocumentsApiDocumentsApiUrl...` | API Gateway URL for document management |
| `VectorIndexVectorIndexArn...` | S3 Vectors index ARN |
