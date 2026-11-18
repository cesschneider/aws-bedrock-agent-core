import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  isValidName,
  normalizeName,
  validateTagsAgainstCatalog,
} from "./catalog-store";

describe("normalizeName", () => {
  it("trims and lowercases", () => {
    expect(normalizeName("  Finance  ")).toBe("finance");
    expect(normalizeName("Q3")).toBe("q3");
  });
});

describe("isValidName", () => {
  it("accepts lowercase alphanumerics, hyphens, underscores", () => {
    expect(isValidName("dept-engineering")).toBe(true);
    expect(isValidName("finance_q3")).toBe(true);
    expect(isValidName("hr")).toBe(true);
  });

  it("rejects spaces, uppercase, punctuation, and empty", () => {
    expect(isValidName("Dept Engineering")).toBe(false);
    expect(isValidName("finance!")).toBe(false);
    expect(isValidName("")).toBe(false);
    expect(isValidName("a".repeat(65))).toBe(false);
  });
});

describe("validateTagsAgainstCatalog", () => {
  const dynamo = { send: jest.fn() } as unknown as DynamoDBClient;

  it("allows any tags when the catalog is empty (backward-compatible)", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Items: [] });
    const result = await validateTagsAgainstCatalog(dynamo, "t", "acme", ["finance", "q3"]);
    expect(result.valid).toBe(true);
    expect(result.unknown).toEqual([]);
  });

  it("rejects tags not in a seeded catalog", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Items: [
        { tenantId: { S: "acme" }, itemKey: { S: "tag#finance" }, kind: { S: "tag" }, name: { S: "finance" }, createdBy: { S: "a@b.c" }, createdAt: { S: "2026-01-01" } },
        { tenantId: { S: "acme" }, itemKey: { S: "tag#q3" }, kind: { S: "tag" }, name: { S: "q3" }, createdBy: { S: "a@b.c" }, createdAt: { S: "2026-01-01" } },
      ],
    });
    const result = await validateTagsAgainstCatalog(dynamo, "t", "acme", ["finance", "unknown-tag"]);
    expect(result.valid).toBe(false);
    expect(result.unknown).toEqual(["unknown-tag"]);
  });

  it("accepts tags that are all in the catalog", async () => {
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Items: [
        { tenantId: { S: "acme" }, itemKey: { S: "tag#finance" }, kind: { S: "tag" }, name: { S: "finance" }, createdBy: { S: "a@b.c" }, createdAt: { S: "2026-01-01" } },
      ],
    });
    const result = await validateTagsAgainstCatalog(dynamo, "t", "acme", ["finance"]);
    expect(result.valid).toBe(true);
  });
});
