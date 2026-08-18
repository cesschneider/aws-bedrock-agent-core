import { S3Client } from "@aws-sdk/client-s3";
import { departmentFromKey, tenantFromKey, presignCitation, s3UriToKey } from "./citations";

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed.example.com/doc?sig=abc"),
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-1" });
const BUCKET = "raw-documents-dev-123456789012";
const TENANT = "acme-com";

describe("s3UriToKey", () => {
  it("strips s3:// URIs to the object key", () => {
    expect(s3UriToKey("s3://my-bucket/acme-com/dept-eng/abc-file.pdf")).toBe(
      "acme-com/dept-eng/abc-file.pdf"
    );
  });

  it("strips ARN-form URIs to the object key", () => {
    expect(s3UriToKey("arn:aws:s3:::my-bucket/acme-com/dept-eng/abc-file.pdf")).toBe(
      "acme-com/dept-eng/abc-file.pdf"
    );
  });
});

describe("tenantFromKey", () => {
  it("returns the first path segment", () => {
    expect(tenantFromKey("acme-com/dept-finance/uuid-report.docx")).toBe("acme-com");
  });

  it("returns empty string for an empty key", () => {
    expect(tenantFromKey("")).toBe("");
  });
});

describe("departmentFromKey", () => {
  it("returns the second path segment", () => {
    expect(departmentFromKey("acme-com/dept-finance/uuid-report.docx")).toBe("dept-finance");
  });

  it("returns empty string for a key with no second segment", () => {
    expect(departmentFromKey("acme-com")).toBe("");
  });
});

describe("presignCitation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns a presigned link when tenant + department match", async () => {
    const link = await presignCitation(
      s3,
      BUCKET,
      "s3://bucket/acme-com/dept-eng/uuid-doc.pdf",
      "ref-1",
      TENANT,
      ["dept-eng", "company-wide"]
    );
    expect(link).toEqual({
      referenceId: "ref-1",
      url: "https://signed.example.com/doc?sig=abc",
    });
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it("returns null when the user lost department access", async () => {
    const link = await presignCitation(
      s3,
      BUCKET,
      "s3://bucket/acme-com/dept-finance/uuid-doc.pdf",
      "ref-2",
      TENANT,
      ["dept-eng", "company-wide"]
    );
    expect(link).toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("returns null when the citation is from a different tenant (defense-in-depth)", async () => {
    const link = await presignCitation(
      s3,
      BUCKET,
      "s3://bucket/other-com/dept-eng/uuid-doc.pdf",
      "ref-3",
      TENANT,
      ["dept-eng", "company-wide"]
    );
    expect(link).toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("returns null when userTenantId is empty", async () => {
    const link = await presignCitation(
      s3,
      BUCKET,
      "s3://bucket/acme-com/dept-eng/uuid-doc.pdf",
      "ref-4",
      "",
      ["dept-eng"]
    );
    expect(link).toBeNull();
  });

  it("always allows company-wide documents within the same tenant", async () => {
    const link = await presignCitation(
      s3,
      BUCKET,
      "s3://bucket/acme-com/company-wide/uuid-handbook.pdf",
      "ref-5",
      TENANT,
      ["company-wide"]
    );
    expect(link).not.toBeNull();
  });
});