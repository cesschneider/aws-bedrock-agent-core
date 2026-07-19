import { S3Client } from "@aws-sdk/client-s3";
import { departmentFromKey, presignCitation, s3UriToKey } from "./citations";

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed.example.com/doc?sig=abc"),
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-1" });
const BUCKET = "raw-documents-dev-123456789012";

describe("s3UriToKey", () => {
  it("strips s3:// URIs to the object key", () => {
    expect(s3UriToKey("s3://my-bucket/dept-eng/abc-file.pdf")).toBe("dept-eng/abc-file.pdf");
  });

  it("strips ARN-form URIs to the object key", () => {
    expect(s3UriToKey("arn:aws:s3:::my-bucket/dept-eng/abc-file.pdf")).toBe(
      "dept-eng/abc-file.pdf"
    );
  });
});

describe("departmentFromKey", () => {
  it("returns the first path segment", () => {
    expect(departmentFromKey("dept-finance/uuid-report.docx")).toBe("dept-finance");
  });

  it("returns empty string for an empty key", () => {
    expect(departmentFromKey("")).toBe("");
  });
});

describe("presignCitation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns a presigned link when the user has department access", async () => {
    const link = await presignCitation(
      s3,
      BUCKET,
      "s3://bucket/dept-eng/uuid-doc.pdf",
      "ref-1",
      ["dept-eng", "company-wide"]
    );
    expect(link).toEqual({ referenceId: "ref-1", url: "https://signed.example.com/doc?sig=abc" });
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it("returns null (omits the citation) when the user lost department access", async () => {
    const link = await presignCitation(
      s3,
      BUCKET,
      "s3://bucket/dept-finance/uuid-doc.pdf",
      "ref-2",
      ["dept-eng", "company-wide"]
    );
    expect(link).toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("always allows company-wide documents", async () => {
    const link = await presignCitation(
      s3,
      BUCKET,
      "s3://bucket/company-wide/uuid-handbook.pdf",
      "ref-3",
      ["company-wide"]
    );
    expect(link).not.toBeNull();
  });
});
