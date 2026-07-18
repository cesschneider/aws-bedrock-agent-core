import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { buildObjectKey, handleUploadRequest } from "./index";

jest.mock("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: jest.fn(),
}));

const mockCreatePresignedPost = createPresignedPost as jest.Mock;

function makeEvent(overrides: {
  body?: string;
  groups?: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: overrides.body,
    requestContext: {
      authorizer: {
        jwt: {
          claims: overrides.groups !== undefined ? { "cognito:groups": overrides.groups } : {},
          scopes: null,
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe("buildObjectKey", () => {
  it("prefixes the key with department and a UUID", () => {
    const key = buildObjectKey("dept-engineering", "report.pdf");
    expect(key).toMatch(/^dept-engineering\/[0-9a-f-]{36}-report\.pdf$/);
  });

  it("strips path separators from the filename to prevent key injection", () => {
    const key = buildObjectKey("dept-engineering", "../../etc/passwd");
    expect(key).not.toContain("../");
    expect(key.split("/")).toHaveLength(2); // department/ + sanitized filename, no extra segments
  });
});

describe("handleUploadRequest", () => {
  const s3Client = new S3Client({ region: "us-east-1" });
  const bucket = "raw-documents-test";

  beforeEach(() => {
    mockCreatePresignedPost.mockReset();
    mockCreatePresignedPost.mockResolvedValue({
      url: "https://raw-documents-test.s3.amazonaws.com/",
      fields: { key: "dept-engineering/some-key.pdf" },
    });
  });

  it("returns a presigned POST for a valid upload to the caller's own department", async () => {
    const event = makeEvent({
      groups: "dept-engineering",
      body: JSON.stringify({
        department: "dept-engineering",
        filename: "report.pdf",
        contentType: "application/pdf",
      }),
    });

    const result = await handleUploadRequest(event, s3Client, bucket);

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body as string);
    expect(parsed.url).toBeDefined();
    expect(parsed.fields).toBeDefined();
    expect(parsed.key).toMatch(/^dept-engineering\//);
    expect(mockCreatePresignedPost).toHaveBeenCalledWith(
      s3Client,
      expect.objectContaining({
        Bucket: bucket,
        Conditions: expect.arrayContaining([["content-length-range", 1, 50 * 1024 * 1024]]),
      })
    );
  });

  it("allows upload to company-wide regardless of department membership", async () => {
    const event = makeEvent({
      groups: "dept-finance",
      body: JSON.stringify({
        department: "company-wide",
        filename: "handbook.pdf",
        contentType: "application/pdf",
      }),
    });

    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(200);
  });

  it("rejects upload to a department the caller does not belong to", async () => {
    const event = makeEvent({
      groups: "dept-finance",
      body: JSON.stringify({
        department: "dept-hr",
        filename: "comp.pdf",
        contentType: "application/pdf",
      }),
    });

    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(403);
    expect(mockCreatePresignedPost).not.toHaveBeenCalled();
  });

  it("rejects a missing request body", async () => {
    const event = makeEvent({ groups: "dept-engineering", body: undefined });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(400);
  });

  it("rejects malformed JSON in the request body", async () => {
    const event = makeEvent({ groups: "dept-engineering", body: "{not json" });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(400);
  });

  it("rejects a disallowed content type", async () => {
    const event = makeEvent({
      groups: "dept-engineering",
      body: JSON.stringify({
        department: "dept-engineering",
        filename: "malware.exe",
        contentType: "application/x-msdownload",
      }),
    });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(400);
  });

  it("rejects a request missing the department field", async () => {
    const event = makeEvent({
      groups: "dept-engineering",
      body: JSON.stringify({ filename: "report.pdf", contentType: "application/pdf" }),
    });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(400);
  });

  it("allows a user with zero department groups to upload only to company-wide", async () => {
    const event = makeEvent({
      groups: "",
      body: JSON.stringify({
        department: "company-wide",
        filename: "notice.pdf",
        contentType: "application/pdf",
      }),
    });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(200);
  });
});
