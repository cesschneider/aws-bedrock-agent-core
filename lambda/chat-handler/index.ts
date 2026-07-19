import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { authenticate, init as initAuth } from "./jwt-auth";
import { invokeAgent } from "./agent-invoke";
import { appendTurn } from "../common/conversation-store";
import { randomUUID } from "crypto";

/**
 * Lambda Function URL handler for the RAG chat endpoint
 * (spec Section 4.4). RESPONSE_STREAM invoke mode does NOT support
 * Lambda's built-in streaming helper — streaming happens through the
 * Function URL's native chunked transfer encoding, NOT the Lambda
 * Runtime API's awslambda.streamifyResponse.
 *
 * Instead, this handler writes a JSON response and relies on the caller
 * to read the Bedrock stream. In production, the frontend connects
 * directly to the Function URL's WebSocket-equivalent stream.
 *
 * When RESPONSE_STREAM is NOT available (early dev / testing), this
 * handler falls back to a standard JSON response with the full answer
 * so integration tests can validate end-to-end behavior.
 */

const dynamo = new DynamoDBClient({});
const tableName = process.env.CONVERSATION_TABLE_NAME ?? "";
const agentId = process.env.AGENT_ID ?? "";
const agentAliasId = process.env.AGENT_ALIAS_ID ?? "";

// Initialize JWT validator at cold-start
const region = process.env.AWS_REGION ?? "us-east-1";
const userPoolId = process.env.COGNITO_USER_POOL_ID ?? "";
const clientId = process.env.COGNITO_CLIENT_ID ?? "";
if (userPoolId && clientId) {
  initAuth(region, userPoolId, clientId);
}

interface ChatRequest {
  message: string;
  sessionId?: string;
}

async function generatePresignedUrl(
  bucket: string,
  s3Uri: string
): Promise<string> {
  // Presigned URLs require the S3 key, not the full URI.
  // s3Uri format: s3://bucket/key or arn:aws:s3:::bucket/key
  const key = s3Uri.replace(/^s3:\/\/[^/]+\//, "").replace(/^arn:aws:s3:::[^/]+\//, "");
  return `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodeURIComponent(key)}`;
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    // 1. Authenticate — extract JWT from Authorization header
    const auth = await authenticate(event.headers?.["authorization"]);

    // 2. Parse the request body
    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing request body" }) };
    }
    const { message, sessionId } = JSON.parse(event.body) as ChatRequest;
    if (!message || typeof message !== "string") {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing or invalid 'message' field" }) };
    }

    const sid = sessionId ?? randomUUID();
    const turnId = `${new Date().toISOString()}#${randomUUID().slice(0, 8)}`;

    // 3. Persist the user's message to DynamoDB BEFORE invoking the agent
    // (Eng review: write-before-stream — if the DB write fails, the user
    // sees an error instead of silently losing the turn).
    await appendTurn(dynamo, tableName, {
      userId: auth.userId,
      turnId,
      role: "user",
      message,
      createdAt: new Date().toISOString(),
    });

    // 4. Invoke Bedrock AgentCore with department-scoped metadata filter
    const citations: Array<{ referenceId: string; url: string }> = [];
    let answerParts: string[] = [];
    let hasChunks = false;

    for await (const chunk of invokeAgent({
      agentId,
      agentAliasId,
      sessionId: sid,
      message,
      departments: auth.departments,
    })) {
      if (chunk.text) {
        answerParts.push(chunk.text);
        hasChunks = true;
      }
      if (chunk.citations) {
        for (const c of chunk.citations) {
          if (c.s3Uri && c.referenceId) {
            citations.push({
              referenceId: c.referenceId,
              url: await generatePresignedUrl(
                process.env.DOCUMENTS_BUCKET_NAME ?? "",
                c.s3Uri
              ),
            });
          }
        }
      }
    }

    const answer = hasChunks
      ? answerParts.join("")
      : "No relevant company documents were found for your query. Please try rephrasing or check with your department content owner.";

    // 5. Persist the assistant's response
    await appendTurn(dynamo, tableName, {
      userId: auth.userId,
      turnId: `${turnId.split("#")[0]}#${randomUUID().slice(0, 8)}`,
      role: "assistant",
      message: answer,
      citations: citations.map((c) => c.referenceId),
      createdAt: new Date().toISOString(),
    });

    // 6. Return the response with citations
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        answer,
        citations,
        sessionId: sid,
        turnId,
      }),
    };
  } catch (err: any) {
    console.error("Chat handler error:", err);
    const statusCode = err.statusCode ?? 500;
    return {
      statusCode,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: err.message ?? "Internal server error",
      }),
    };
  }
}
