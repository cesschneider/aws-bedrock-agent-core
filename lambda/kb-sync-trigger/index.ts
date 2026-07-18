import type { S3Event, S3EventRecord } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  PutItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { BedrockAgentClient, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";

/** Skip re-ingesting metadata sidecars we just wrote ourselves (would otherwise loop). */
const METADATA_SUFFIX = ".metadata.json";

/** Dedup claim TTL — long enough to absorb S3's at-least-once redelivery window. */
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

export interface KbSyncDependencies {
  s3: S3Client;
  dynamo: DynamoDBClient;
  bedrockAgent: BedrockAgentClient;
  dedupTableName: string;
  knowledgeBaseId: string;
  dataSourceId: string;
}

/**
 * Extracts the department from the object key prefix, per the upload
 * convention `{department}/{uuid}-{filename}` (spec Section 4.2/5).
 */
export function departmentFromKey(key: string): string {
  const [department] = key.split("/");
  if (!department) {
    throw new Error(`Cannot determine department from object key "${key}"`);
  }
  return department;
}

/**
 * Atomically claims (objectKey, etag) so duplicate S3 ObjectCreated
 * deliveries (at-least-once) trigger exactly one ingestion job
 * (Eng review addition, spec Section 4.3).
 *
 * Returns true if this invocation won the claim (should proceed),
 * false if another invocation already claimed it (should skip).
 */
export async function claimForProcessing(
  dynamo: DynamoDBClient,
  tableName: string,
  objectKey: string,
  etag: string
): Promise<boolean> {
  const expiresAt = Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS;
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          dedupeKey: { S: `${objectKey}#${etag}` },
          expiresAt: { N: String(expiresAt) },
        },
        ConditionExpression: "attribute_not_exists(dedupeKey)",
      })
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
}

async function writeMetadataSidecar(
  s3: S3Client,
  bucket: string,
  objectKey: string,
  department: string
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${objectKey}${METADATA_SUFFIX}`,
      Body: JSON.stringify({ metadataAttributes: { department } }),
      ContentType: "application/json",
    })
  );
}

async function processRecord(record: S3EventRecord, deps: KbSyncDependencies): Promise<void> {
  const bucket = record.s3.bucket.name;
  const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
  const etag = record.s3.object.eTag;

  if (objectKey.endsWith(METADATA_SUFFIX)) {
    return; // our own sidecar write triggered this event — ignore
  }

  const claimed = await claimForProcessing(deps.dynamo, deps.dedupTableName, objectKey, etag);
  if (!claimed) {
    return; // duplicate delivery of an event we already processed
  }

  const department = departmentFromKey(objectKey);
  await writeMetadataSidecar(deps.s3, bucket, objectKey, department);

  await deps.bedrockAgent.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: deps.knowledgeBaseId,
      dataSourceId: deps.dataSourceId,
      description: `Triggered by upload of ${objectKey}`,
    })
  );
}

export async function handleS3Event(event: S3Event, deps: KbSyncDependencies): Promise<void> {
  // Process sequentially, not Promise.all — a failure on one record should
  // not swallow errors on records processed after it (async invocation
  // retry/DLQ semantics apply to the whole batch either way, but sequential
  // processing keeps dedup claims from racing on hot single-object bursts).
  for (const record of event.Records) {
    await processRecord(record, deps);
  }
}

const s3 = new S3Client({});
const dynamo = new DynamoDBClient({});
const bedrockAgent = new BedrockAgentClient({});

export const handler = async (event: S3Event): Promise<void> => {
  const dedupTableName = process.env.DEDUP_TABLE_NAME ?? "";
  const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID ?? "";
  const dataSourceId = process.env.DATA_SOURCE_ID ?? "";
  if (!dedupTableName || !knowledgeBaseId || !dataSourceId) {
    throw new Error(
      "DEDUP_TABLE_NAME, KNOWLEDGE_BASE_ID, and DATA_SOURCE_ID environment variables are required"
    );
  }
  await handleS3Event(event, { s3, dynamo, bedrockAgent, dedupTableName, knowledgeBaseId, dataSourceId });
};
