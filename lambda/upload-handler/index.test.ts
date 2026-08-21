import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { buildObjectKey, handleUploadRequest, UploadDependencies } from "./index";

jest.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: jest.fn(),
}));

const mockCreatePresignedPost = createPresignedPost as jest.Mock;

function makeEvent(overrides: {
  body?: string;
  groups?: string;
  tenantId?: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, string> = {};
  if (overrides.groups !== undefined) {
    claims["custom:departments"] = overrides.groups;
  }
  // Default tenant for all tests; individual tests can override.
  claims["custom:tenantId"] = overrides.tenantId ?? "acme-com";
  claims["cognito:username"] = "dev-tester";
  return {
    body: overrides.body,
    requestContext: {
      authorizer: {
        jwt: {
          claims,
          scopes: null,
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function makeDeps(): UploadDependencies {
  return {
    s3Client: new S3Client({ region: "us-east-1" }),
    dynamo: { send: jest.fn().mockResolvedValue({}) } as unknown as DynamoDBClient,
    bucketName: "raw-documents-test",
    registryTableName: "document-registry-test",
  };
}

describe("buildObjectKey", () => {
  it("prefixes the key with tenant, department, documentId and a filename", () => {
    const key = buildObjectKey("acme-com", "dept-engineering", "11111111-1111-1111-1111-111111111111", "report.pdf");
    expect(key).toBe("acme-com/dept-engineering/11111111-1111-1111-1111-111111111111-report.pdf");
  });

  it("strips path separators from the filename to prevent key injection", () => {
    const key = buildObjectKey("acme-com", "dept-engineering", "11111111-1111-1111-1111-111111111111", "../../etc/passwd");
    expect(key).not.toContain("../");
    // tenant/department/sanitized — exactly 3 segments
    expect(key.split("/")).toHaveLength(3);
  });
});

describe("handleUploadRequest", () => {
  beforeEach(() => {
    mockCreatePresignedPost.mockReset();
    mockCreatePresignedPost.mockResolvedValue({
      url: "https://raw-documents-test.s3.amazonaws.com/",
      fields: { key: "dept-engineering/some-key.pdf" },
    });
  });

  it("returns a presigned POST for a valid upload to the caller's own department", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      groups: "acme-com:dept-engineering",
      body: JSON.stringify({
        department: "dept-engineering",
        filename: "report.pdf",
        contentType: "application/pdf",
      }),
    });

    const result = await handleUploadRequest(event, deps);

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body as string);
    expect(parsed.url).toBeDefined();
    expect(parsed.fields).toBeDefined();
    expect(parsed.key).toMatch(/^acme-com\/dept-engineering\//);
    expect(parsed.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockCreatePresignedPost).toHaveBeenCalledWith(
      deps.s3Client,
      expect.objectContaining({
        Bucket: deps.bucketName,
        Conditions: expect.arrayContaining([["content-length-range", 1, 50 * 1024 * 1024]]),
      })
    );
    // A PENDING registry record is written at upload time.
    expect(deps.dynamo.send).toHaveBeenCalled();
  });

  it("accepts and normalizes tags, writing them to the registry record", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      groups: "acme-com:dept-engineering",
      body: JSON.stringify({
        department: "dept-engineering",
        filename: "report.pdf",
        contentType: "application/pdf",
        tags: ["  finance ", "finance", "q3"],
      }),
    });

    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(200);

    const putCall = (deps.dynamo.send as jest.Mock).mock.calls[0][0];
    expect(putCall.input.Item.tags.SS).toEqual(["finance", "q3"]);
  });

  it("rejects non-array tags", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      groups: "acme-com:dept-engineering",
      body: JSON.stringify({
        department: "dept-engineering",
        filename: "report.pdf",
        contentType: "application/pdf",
        tags: "finance",
      }),
    });

    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(400);
  });

  it("allows upload to org-wide regardless of department membership", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      groups: "acme-com:dept-finance",
      body: JSON.stringify({
        department: "org-wide",
        filename: "handbook.pdf",
        contentType: "application/pdf",
      }),
    });

    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(200);
  });

  it("rejects upload to a department the caller does not belong to", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      groups: "acme-com:dept-finance",
      body: JSON.stringify({
        department: "dept-hr",
        filename: "comp.pdf",
        contentType: "application/pdf",
      }),
    });

    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(403);
    expect(mockCreatePresignedPost).not.toHaveBeenCalled();
  });

  it("rejects a missing request body", async () => {
    const deps = makeDeps();
    const event = makeEvent({ groups: "acme-com:dept-engineering", body: undefined });
    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(400);
  });

  it("rejects malformed JSON in the request body", async () => {
    const deps = makeDeps();
    const event = makeEvent({ groups: "acme-com:dept-engineering", body: "{not json" });
    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(400);
  });

  it("rejects a disallowed content type", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      groups: "acme-com:dept-engineering",
      body: JSON.stringify({
        department: "dept-engineering",
        filename: "malware.exe",
        contentType: "application/x-msdownload",
      }),
    });
    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(400);
  });

  it("rejects a request missing the department field", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      groups: "acme-com:dept-engineering",
      body: JSON.stringify({ filename: "report.pdf", contentType: "application/pdf" }),
    });
    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(400);
  });

  it("allows a user with zero department groups to upload to org-wide", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      groups: "",
      body: JSON.stringify({
        department: "org-wide",
        filename: "notice.pdf",
        contentType: "application/pdf",
      }),
    });
    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(200);
  });

  it("rejects a request when the tenant claim is missing (401)", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      groups: "acme-com:dept-engineering",
      tenantId: "",
      body: JSON.stringify({
        department: "dept-engineering",
        filename: "report.pdf",
        contentType: "application/pdf",
      }),
    });
    const result = await handleUploadRequest(event, deps);
    expect(result.statusCode).toBe(401);
    expect(mockCreatePresignedPost).not.toHaveBeenCalled();
  });
});
