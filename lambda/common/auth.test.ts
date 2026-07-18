import { COMPANY_WIDE, parseDepartmentClaims, userCanAccessDepartment } from "./auth";

describe("parseDepartmentClaims", () => {
  it("parses a comma-separated cognito:groups claim and adds company-wide", () => {
    const result = parseDepartmentClaims({ "cognito:groups": "dept-engineering,dept-finance" });
    expect(result).toEqual(expect.arrayContaining(["dept-engineering", "dept-finance", COMPANY_WIDE]));
    expect(result).toHaveLength(3);
  });

  it("handles a single-group claim", () => {
    const result = parseDepartmentClaims({ "cognito:groups": "dept-engineering" });
    expect(result).toEqual(expect.arrayContaining(["dept-engineering", COMPANY_WIDE]));
  });

  it("trims whitespace around group names", () => {
    const result = parseDepartmentClaims({ "cognito:groups": " dept-engineering , dept-finance " });
    expect(result).toContain("dept-engineering");
    expect(result).toContain("dept-finance");
  });

  it("returns only company-wide for a user with zero department groups", () => {
    const result = parseDepartmentClaims({ "cognito:groups": "" });
    expect(result).toEqual([COMPANY_WIDE]);
  });

  it("returns only company-wide when the claim is entirely missing", () => {
    const result = parseDepartmentClaims(undefined);
    expect(result).toEqual([COMPANY_WIDE]);
  });

  it("does not duplicate company-wide if a real group happens to share the name", () => {
    const result = parseDepartmentClaims({ "cognito:groups": `dept-eng,${COMPANY_WIDE}` });
    expect(result.filter((d) => d === COMPANY_WIDE)).toHaveLength(1);
  });
});

describe("userCanAccessDepartment", () => {
  it("returns true when the department is in the user's list", () => {
    expect(userCanAccessDepartment(["dept-eng", COMPANY_WIDE], "dept-eng")).toBe(true);
  });

  it("returns false when the department is not in the user's list", () => {
    expect(userCanAccessDepartment(["dept-eng", COMPANY_WIDE], "dept-hr")).toBe(false);
  });
});
