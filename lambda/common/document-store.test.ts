import { documentIdFromKey } from "./document-store";

describe("documentIdFromKey", () => {
  it("extracts the UUID from a standard object key", () => {
    expect(
      documentIdFromKey("acme-com/dept-engineering/11111111-1111-1111-1111-111111111111-report.pdf")
    ).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("extracts the UUID when the filename contains dashes", () => {
    expect(
      documentIdFromKey("acme-com/org-wide/22222222-2222-2222-2222-222222222222-my-report-v2.pdf")
    ).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("throws when the key has no UUID prefix", () => {
    expect(() => documentIdFromKey("acme-com/dept-engineering/report.pdf")).toThrow();
  });

  it("throws on an empty key", () => {
    expect(() => documentIdFromKey("")).toThrow();
  });
});
