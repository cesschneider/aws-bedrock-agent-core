import {
  COMPANY_WIDE,
  ORG_WIDE,
  domainFromEmail,
  namespacedDepartment,
  parseDepartmentClaims,
  tenantOrgWide,
  userCanAccessDepartment,
} from "./auth";

describe("parseDepartmentClaims", () => {
  it("parses a comma-separated custom:departments claim (already namespaced)", () => {
    const result = parseDepartmentClaims({
      "custom:departments": "acme-com:engineering,acme-com:finance",
    });
    expect(result).toEqual(["acme-com:engineering", "acme-com:finance"]);
  });

  it("parses a single group", () => {
    const result = parseDepartmentClaims({ "custom:departments": "acme-com:engineering" });
    expect(result).toEqual(["acme-com:engineering"]);
  });

  it("trims whitespace around group names", () => {
    const result = parseDepartmentClaims({
      "custom:departments": " acme-com:engineering , acme-com:finance ",
    });
    expect(result).toEqual(["acme-com:engineering", "acme-com:finance"]);
  });

  it("returns an empty array for a user with zero department groups", () => {
    const result = parseDepartmentClaims({ "custom:departments": "" });
    expect(result).toEqual([]);
  });

  it("returns an empty array when the claim is entirely missing", () => {
    const result = parseDepartmentClaims(undefined);
    expect(result).toEqual([]);
  });

  it("does NOT inject org-wide (that requires tenant context)", () => {
    const result = parseDepartmentClaims({ "custom:departments": "acme-com:engineering" });
    expect(result).not.toContain("acme-com:org-wide");
  });
});

describe("tenantOrgWide", () => {
  it("namespaces the org-wide scope per tenant", () => {
    expect(tenantOrgWide("acme-com")).toBe("acme-com:org-wide");
  });
});

describe("namespacedDepartment", () => {
  it("namespaces a department per tenant", () => {
    expect(namespacedDepartment("acme-com", "engineering")).toBe("acme-com:engineering");
  });
});

describe("domainFromEmail", () => {
  it("extracts the lowercased domain", () => {
    expect(domainFromEmail("Alice@Acme.COM")).toBe("acme.com");
  });

  it("throws on a malformed email", () => {
    expect(() => domainFromEmail("no-at-sign")).toThrow();
  });
});

describe("userCanAccessDepartment", () => {
  it("returns true when the user belongs to the department", () => {
    expect(userCanAccessDepartment(["acme-com:engineering", "acme-com:org-wide"], "acme-com:engineering")).toBe(true);
  });

  it("returns false when the user does not belong to the department", () => {
    expect(userCanAccessDepartment(["acme-com:engineering", "acme-com:org-wide"], "acme-com:hr")).toBe(false);
  });

  it("returns true for the tenant's org-wide scope", () => {
    expect(userCanAccessDepartment(["acme-com:engineering", "acme-com:org-wide"], "acme-com:org-wide")).toBe(true);
  });
});

// Legacy constants retained for backward-compat references; the multi-tenant
// model uses ORG_WIDE (per-tenant) instead of COMPANY_WIDE (global).
describe("legacy constants", () => {
  it("COMPANY_WIDE is still exported for compatibility", () => {
    expect(COMPANY_WIDE).toBe("company-wide");
  });
  it("ORG_WIDE is the per-tenant reserved scope", () => {
    expect(ORG_WIDE).toBe("org-wide");
  });
});
