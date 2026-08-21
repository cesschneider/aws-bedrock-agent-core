import {
  buildRetrievalFilter,
  buildKnowledgeBaseConfiguration,
  TenantScopeError,
} from "./agent-invoke";

/**
 * STORY-A tests — the mandatory tenant + department retrieval filter
 * (multi-tenant design §4.3). The filter must always be present, fail
 * closed on a missing tenant, and always include the tenant's org-wide scope.
 */

describe("buildRetrievalFilter", () => {
  it("builds an andAll filter with tenantId equals and department in-list", () => {
    const filter = buildRetrievalFilter("acme", ["acme:dept-engineering"]);
    expect(filter.andAll).toHaveLength(2);

    const [tenantClause, deptClause] = filter.andAll!;
    expect(tenantClause.equals).toEqual({ key: "tenantId", value: "acme" });
    expect(deptClause.in).toEqual({
      key: "department",
      value: ["acme:dept-engineering", "acme:org-wide"],
    });
  });

  it("always appends the tenant's org-wide scope", () => {
    const filter = buildRetrievalFilter("acme", []);
    const deptClause = filter.andAll![1];
    expect(deptClause.in!.value).toEqual(["acme:org-wide"]);
  });

  it("dedupes departments and org-wide", () => {
    const filter = buildRetrievalFilter("acme", ["acme:org-wide", "acme:dept-eng"]);
    const deptClause = filter.andAll![1];
    const values = deptClause.in!.value as string[];
    expect(values.filter((v) => v === "acme:org-wide")).toHaveLength(1);
  });

  it("fails closed on an empty tenantId", () => {
    expect(() => buildRetrievalFilter("", ["acme:dept-eng"])).toThrow(TenantScopeError);
  });

  it("fails closed on a whitespace-only tenantId", () => {
    expect(() => buildRetrievalFilter("   ", ["acme:dept-eng"])).toThrow(TenantScopeError);
  });

  it("uses the tenantId value verbatim (not derived from departments)", () => {
    const filter = buildRetrievalFilter("globex", ["acme:dept-eng"]);
    expect(filter.andAll![0].equals!.value).toBe("globex");
  });

  it("adds a tags IN clause when tags are provided", () => {
    const filter = buildRetrievalFilter("acme", ["acme:dept-eng"], ["finance", "q3"]);
    expect(filter.andAll).toHaveLength(3);
    expect(filter.andAll![2].in).toEqual({ key: "tags", value: ["finance", "q3"] });
  });

  it("omits the tags clause when tags are empty or absent", () => {
    expect(buildRetrievalFilter("acme", ["acme:dept-eng"], []).andAll).toHaveLength(2);
    expect(buildRetrievalFilter("acme", ["acme:dept-eng"], undefined).andAll).toHaveLength(2);
  });

  it("normalizes tags (trim + dedupe) and drops blanks", () => {
    const filter = buildRetrievalFilter("acme", ["acme:dept-eng"], [" finance ", "finance", "", "q3"]);
    expect(filter.andAll![2].in!.value).toEqual(["finance", "q3"]);
  });
});

describe("buildKnowledgeBaseConfiguration", () => {
  it("wraps the filter in a vectorSearchConfiguration for the given KB", () => {
    const filter = buildRetrievalFilter("acme", ["acme:dept-eng"]);
    const cfg = buildKnowledgeBaseConfiguration("KB123", filter);
    expect(cfg.knowledgeBaseId).toBe("KB123");
    expect(cfg.retrievalConfiguration?.vectorSearchConfiguration?.filter).toEqual(filter);
  });
});
