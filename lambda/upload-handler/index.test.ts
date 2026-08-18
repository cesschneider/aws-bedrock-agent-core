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
  tenantId?: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, string> = {};
  if (overrides.groups !== undefined) {
    claims["cognito:groups"] = overrides.groups;
  }
  // Default tenant for all tests; individual tests can override.
  claims["custom:tenantId"] = overrides.tenantId ?? "acme-com";
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

describe("buildObjectKey", () => {
  it("prefixes the key with tenant, department and a UUID", () => {
    const key = buildObjectKey("acme-com", "dept-engineering", "report.pdf");
    expect(key).toMatch(/^acme-com\/dept-engineering\/[0-9a-f-]{36}-report\.pdf$/);
  });

  it("strips path separators from the filename to prevent key injection", () => {
    const key = buildObjectKey("acme-com", "dept-engineering", "../../etc/passwd");
    expect(key).not.toContain("../");
    // tenant/department/sanitized — exactly 3 segments
    expect(key.split("/")).toHaveLength(3);
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
      groups: "acme-com:dept-engineering",
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
    expect(parsed.key).toMatch(/^acme-com\/dept-engineering\//);
    expect(mockCreatePresignedPost).toHaveBeenCalledWith(
      s3Client,
      expect.objectContaining({
        Bucket: bucket,
        Conditions: expect.arrayContaining([["content-length-range", 1, 50 * 1024 * 1024]]),
      })
    );
  });

  it("allows upload to org-wide regardless of department membership", async () => {
    const event = makeEvent({
      groups: "acme-com:dept-finance",
      body: JSON.stringify({
        department: "org-wide",
        filename: "handbook.pdf",
        contentType: "application/pdf",
      }),
    });

    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(200);
  });

  it("rejects upload to a department the caller does not belong to", async () => {
    const event = makeEvent({
      groups: "acme-com:dept-finance",
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
    const event = makeEvent({ groups: "acme-com:dept-engineering", body: undefined });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(400);
  });

  it("rejects malformed JSON in the request body", async () => {
    const event = makeEvent({ groups: "acme-com:dept-engineering", body: "{not json" });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(400);
  });

  it("rejects a disallowed content type", async () => {
    const event = makeEvent({
      groups: "acme-com:dept-engineering",
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
      groups: "acme-com:dept-engineering",
      body: JSON.stringify({ filename: "report.pdf", contentType: "application/pdf" }),
    });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(400);
  });

  it("allows a user with zero department groups to upload to org-wide", async () => {
    const event = makeEvent({
      groups: "",
      body: JSON.stringify({
        department: "org-wide",
        filename: "notice.pdf",
        contentType: "application/pdf",
      }),
    });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(200);
  });

  it("rejects a request when the tenant claim is missing (401)", async () => {
    const event = makeEvent({
      groups: "acme-com:dept-engineering",
      tenantId: "",
      body: JSON.stringify({
        department: "dept-engineering",
        filename: "report.pdf",
        contentType: "application/pdf",
      }),
    });
    const result = await handleUploadRequest(event, s3Client, bucket);
    expect(result.statusCode).toBe(401);
    expect(mockCreatePresignedPost).not.toHaveBeenCalled();
  });
});

