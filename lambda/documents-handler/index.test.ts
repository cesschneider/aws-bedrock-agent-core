import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { handleList, handleGet, handleDelete } from "./index";

// The handler reads module-level `dynamo`/`s3`/`tableName`/`bucketName`
// constants, so we test the exported handle* functions by mocking the SDK
// clients at the module level via jest.mock on the SDK modules.

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

const DOC_ID = "11111111-1111-1111-1111-111111111111";

function makeEvent(overrides: {
  groups?: string;
  tenantId?: string;
  method?: string;
  path?: string;
}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, string> = {};
  claims["custom:departments"] = overrides.groups ?? "acme-com:dept-engineering";
  claims["custom:tenantId"] = overrides.tenantId ?? "acme-com";
  return {
    requestContext: {
      authorizer: { jwt: { claims, scopes: null } },
      http: { method: overrides.method ?? "GET", path: overrides.path ?? "/documents" },
    },
    rawPath: overrides.path ?? "/documents",
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

// The module-level clients are created at import time; grab them via the
// mocked constructors.
const dynamo = (DynamoDBClient as unknown as jest.Mock).mock.results[0]?.value;
const s3 = (S3Client as unknown as jest.Mock).mock.results[0]?.value;

describe("documents-handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lists documents for the caller's tenant and departments", async () => {
    (dynamo.send as jest.Mock).mockResolvedValue({
      Items: [
        {
          tenantId: { S: "acme-com" },
          documentId: { S: DOC_ID },
          department: { S: "acme-com:dept-engineering" },
          plainDepartment: { S: "dept-engineering" },
          filename: { S: "report.pdf" },
          contentType: { S: "application/pdf" },
          sizeBytes: { N: "1024" },
          tags: { SS: ["finance"] },
          status: { S: "INDEXED" },
          s3Key: { S: `acme-com/dept-engineering/${DOC_ID}-report.pdf` },
          uploadedBy: { S: "dev-tester" },
          uploadedAt: { S: "2026-08-21T00:00:00.000Z" },
        },
      ],
    });

    const result = await handleList(makeEvent({}));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].documentId).toBe(DOC_ID);
    expect(body.documents[0].tags).toEqual(["finance"]);
    expect(body.documents[0].sizeBytes).toBe(1024);
  });

  it("returns 404 when getting a missing document", async () => {
    (dynamo.send as jest.Mock).mockResolvedValue({ Item: undefined });

    const result = await handleGet(makeEvent({ path: `/documents/${DOC_ID}` }), DOC_ID);

    expect(result.statusCode).toBe(404);
  });

  it("returns 403 when the caller is not in the document's department", async () => {
    (dynamo.send as jest.Mock).mockResolvedValue({
      Item: {
        tenantId: { S: "acme-com" },
        documentId: { S: DOC_ID },
        department: { S: "acme-com:dept-finance" },
        plainDepartment: { S: "dept-finance" },
        filename: { S: "report.pdf" },
        contentType: { S: "application/pdf" },
        sizeBytes: { N: "1024" },
        status: { S: "INDEXED" },
        s3Key: { S: `acme-com/dept-finance/${DOC_ID}-report.pdf` },
        uploadedBy: { S: "dev-tester" },
        uploadedAt: { S: "2026-08-21T00:00:00.000Z" },
      },
    });

    const result = await handleGet(makeEvent({ path: `/documents/${DOC_ID}` }), DOC_ID);

    expect(result.statusCode).toBe(403);
  });

  it("deletes the S3 object, sidecar, and registry record", async () => {
    (dynamo.send as jest.Mock).mockResolvedValue({
      Item: {
        tenantId: { S: "acme-com" },
        documentId: { S: DOC_ID },
        department: { S: "acme-com:dept-engineering" },
        plainDepartment: { S: "dept-engineering" },
        filename: { S: "report.pdf" },
        contentType: { S: "application/pdf" },
        sizeBytes: { N: "1024" },
        status: { S: "INDEXED" },
        s3Key: { S: `acme-com/dept-engineering/${DOC_ID}-report.pdf` },
        uploadedBy: { S: "dev-tester" },
        uploadedAt: { S: "2026-08-21T00:00:00.000Z" },
      },
    });

    const result = await handleDelete(makeEvent({ method: "DELETE", path: `/documents/${DOC_ID}` }), DOC_ID);

    expect(result.statusCode).toBe(200);
    expect(s3.send).toHaveBeenCalledTimes(2); // object + sidecar
  });
});
