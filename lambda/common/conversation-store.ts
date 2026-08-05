import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

/**
 * Persistent, cross-session conversation history (spec Section 4.4,
 * "Session/memory (hybrid)"). The Bedrock Agent's native sessionId holds
 * short-term in-session state separately; this store is the durable
 * long-term record keyed by user ID.
 *
 * Retention/TTL policy was flagged as TBD in the spec (Section 7) — this
 * defaults to 180 days via the `expiresAt` TTL attribute. Adjust
 * DEFAULT_TTL_DAYS (or pass an explicit ttlDays) once that decision is
 * finalized; it is not meant to be a silent permanent choice.
 */
const DEFAULT_TTL_DAYS = 180;

export type ConversationRole = "user" | "assistant";

export interface ConversationTurn {
  userId: string;
  turnId: string; // sortable, e.g. `${ISO timestamp}#${uuid}`
  role: ConversationRole;
  message: string;
  citations?: string[];
  createdAt: string; // ISO 8601
}

export async function appendTurn(
  dynamo: DynamoDBClient,
  tableName: string,
  turn: ConversationTurn,
  ttlDays: number = DEFAULT_TTL_DAYS
): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;

  const item: Record<string, AttributeValue> = {
    userId: { S: turn.userId },
    turnId: { S: turn.turnId },
    role: { S: turn.role },
    message: { S: turn.message },
    createdAt: { S: turn.createdAt },
    expiresAt: { N: String(expiresAt) },
  };
  if (turn.citations && turn.citations.length > 0) {
    item.citations = { SS: turn.citations };
  }

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: item,
    })
  );
}

export async function getRecentTurns(
  dynamo: DynamoDBClient,
  tableName: string,
  userId: string,
  limit = 20
): Promise<ConversationTurn[]> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": { S: userId },
      },
      ScanIndexForward: false, // most recent turnId first
      Limit: limit,
    })
  );

  return (result.Items ?? []).map((item) => ({
    userId: item.userId.S as string,
    turnId: item.turnId.S as string,
    role: item.role.S as ConversationRole,
    message: item.message.S as string,
    citations: item.citations?.SS,
    createdAt: item.createdAt.S as string,
  }));
}

