import type { S3Event } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  PutItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { BedrockAgentClient, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { claimForProcessing, departmentFromKey, tenantFromKey, handleS3Event, KbSyncDependencies } from "./index";

function makeS3Event(overrides: { key: string; etag?: string; bucket?: string }): S3Event {
  return {
    Records: [
      {
        s3: {
          bucket: { name: overrides.bucket ?? "raw-documents-test", arn: "", ownerIdentity: { principalId: "" } },
          object: {
            key: overrides.key,
            eTag: overrides.etag ?? "etag-1",
            size: 100,
            versionId: "",
            sequencer: "",
          },
          s3SchemaVersion: "1.0",
          configurationId: "",
        },
      } as unknown as S3Event["Records"][number],
    ],
  };
}

describe("tenantFromKey", () => {
  it("extracts the tenant from the first key segment", () => {
    expect(tenantFromKey("acme-com/dept-engineering/uuid-report.pdf")).toBe("acme-com");
  });

  it("throws when the key has no segments", () => {
    expect(() => tenantFromKey("")).toThrow();
  });
});

describe("departmentFromKey", () => {
  it("extracts the department from the second key segment", () => {
    expect(departmentFromKey("acme-com/dept-engineering/uuid-report.pdf")).toBe("dept-engineering");
  });

  it("extracts org-wide as a department value", () => {
    expect(departmentFromKey("acme-com/org-wide/uuid-handbook.pdf")).toBe("org-wide");
  });

  it("throws when the key has no department segment", () => {
    expect(() => departmentFromKey("acme-com")).toThrow();
  });
});

describe("claimForProcessing", () => {
  it("returns true and writes a claim when the key is not already claimed", async () => {
    const send = jest.fn().mockResolvedValue({});
    const dynamo = { send } as unknown as DynamoDBClient;

    const result = await claimForProcessing(dynamo, "dedup-table", "dept-eng/uuid-a.pdf", "etag-1");

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.any(PutItemCommand));
  });

  it("returns false when the key+etag was already claimed (duplicate delivery)", async () => {
    const send = jest.fn().mockRejectedValue(
      new ConditionalCheckFailedException({ message: "already claimed", $metadata: {} })
    );
    const dynamo = { send } as unknown as DynamoDBClient;

    const result = await claimForProcessing(dynamo, "dedup-table", "dept-eng/uuid-a.pdf", "etag-1");

    expect(result).toBe(false);
  });

  it("propagates unexpected errors rather than swallowing them", async () => {
    const send = jest.fn().mockRejectedValue(new Error("DynamoDB throttled"));
    const dynamo = { send } as unknown as DynamoDBClient;

    await expect(
      claimForProcessing(dynamo, "dedup-table", "dept-eng/uuid-a.pdf", "etag-1")
    ).rejects.toThrow("DynamoDB throttled");
  });
});

describe("handleS3Event", () => {
  function makeDeps(overrides: Partial<KbSyncDependencies> = {}): KbSyncDependencies {
    return {
      s3: { send: jest.fn().mockResolvedValue({}) } as unknown as S3Client,
      dynamo: { send: jest.fn().mockResolvedValue({}) } as unknown as DynamoDBClient,
      bedrockAgent: { send: jest.fn().mockResolvedValue({}) } as unknown as BedrockAgentClient,
      dedupTableName: "dedup-table",
      knowledgeBaseId: "kb-123",
      dataSourceId: "ds-456",
      ...overrides,
    };
  }

  it("writes a metadata sidecar and starts an ingestion job for a new object", async () => {
    const deps = makeDeps();
    const event = makeS3Event({ key: "acme-com/dept-engineering/uuid-report.pdf" });

    await handleS3Event(event, deps);

    expect(deps.s3.send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    const putCall = (deps.s3.send as jest.Mock).mock.calls[0][0] as PutObjectCommand;
    expect(putCall.input.Key).toBe("acme-com/dept-engineering/uuid-report.pdf.metadata.json");
    expect(JSON.parse(putCall.input.Body as string)).toEqual({
      metadataAttributes: { tenantId: "acme-com", department: "acme-com:dept-engineering" },
    });
    expect(deps.bedrockAgent.send).toHaveBeenCalledWith(expect.any(StartIngestionJobCommand));
  });

  it("skips processing a duplicate (already-claimed) delivery", async () => {
    const dynamo = {
      send: jest
        .fn()
        .mockRejectedValue(new ConditionalCheckFailedException({ message: "dup", $metadata: {} })),
    } as unknown as DynamoDBClient;
    const deps = makeDeps({ dynamo });
    const event = makeS3Event({ key: "acme-com/dept-engineering/uuid-report.pdf" });

    await handleS3Event(event, deps);

    expect(deps.s3.send).not.toHaveBeenCalled();
    expect(deps.bedrockAgent.send).not.toHaveBeenCalled();
  });

  it("ignores events for its own metadata sidecar objects (no infinite loop)", async () => {
    const deps = makeDeps();
    const event = makeS3Event({ key: "acme-com/dept-engineering/uuid-report.pdf.metadata.json" });

    await handleS3Event(event, deps);

    expect(deps.dynamo.send).not.toHaveBeenCalled();
    expect(deps.s3.send).not.toHaveBeenCalled();
    expect(deps.bedrockAgent.send).not.toHaveBeenCalled();
  });

  it("decodes URL-encoded S3 keys (e.g. spaces as +)", async () => {
    const deps = makeDeps();
    const event = makeS3Event({ key: "acme-com/dept-engineering/uuid-my+report.pdf" });

    await handleS3Event(event, deps);

    const putCall = (deps.s3.send as jest.Mock).mock.calls[0][0] as PutObjectCommand;
    expect(putCall.input.Key).toBe("acme-com/dept-engineering/uuid-my report.pdf.metadata.json");
  });

  it("propagates ingestion job failures so Lambda's async retry/DLQ handles them", async () => {
    const bedrockAgent = {
      send: jest.fn().mockRejectedValue(new Error("StartIngestionJob failed")),
    } as unknown as BedrockAgentClient;
    const deps = makeDeps({ bedrockAgent });
    const event = makeS3Event({ key: "acme-com/dept-engineering/uuid-report.pdf" });

    await expect(handleS3Event(event, deps)).rejects.toThrow("StartIngestionJob failed");
  });
});

