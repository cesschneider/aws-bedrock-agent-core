/**
 * Multi-tenant data isolation matrix (3 tenants × multiple departments).
 *
 * This test validates the ACTUAL isolation primitives — `buildRetrievalFilter`
 * (the vector-level filter sent to Bedrock) and `presignCitation` (the
 * link-generation re-check) — against realistic sample data.
 *
 * It simulates the Bedrock vector store: a flat list of documents, each with
 * `tenantId` and `department` metadata. For each user we build their filter,
 * apply it exactly as Bedrock would (tenantId equals + department in-list),
 * and assert the visible set is correct.
 *
 * Isolation guarantees under test:
 *   1. Same tenant, same department  → VISIBLE
 *   2. Same tenant, other department → HIDDEN
 *   3. Same tenant, org-wide         → VISIBLE (to everyone in that tenant)
 *   4. Different tenant, any dept    → HIDDEN
 */

import { buildRetrievalFilter } from "../lambda/chat-handler/agent-invoke";
import { presignCitation, s3UriToKey } from "../lambda/chat-handler/citations";
import { S3Client } from "@aws-sdk/client-s3";
import {
  DOCUMENTS,
  USERS,
  TENANTS,
  userByEmail,
  documentByTopic,
  type DocumentFixture,
} from "./fixtures/tenant-data";

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn().mockResolvedValue("https://signed.example.com/doc"),
}));

const s3 = new S3Client({ region: "us-east-1" });
const BUCKET = "raw-documents-dev";

/**
 * Simulates Bedrock's vector-search filter: given a filter and the full
 * document set, return the documents that match. This mirrors the
 * `andAll` semantics — a document is visible only if it satisfies EVERY
 * clause (tenantId equals AND department in-list).
 */
function applyFilter(
  filter: ReturnType<typeof buildRetrievalFilter>,
  allDocs: DocumentFixture[]
): DocumentFixture[] {
  const tenantClause = filter.andAll![0].equals!;
  const deptClause = filter.andAll![1].in!;

  return allDocs.filter((doc) => {
    const tenantMatches = doc.tenantId === tenantClause.value;
    const deptMatches = (deptClause.value as string[]).includes(doc.department);
    return tenantMatches && deptMatches;
  });
}

/** The full "vector store" — every document across all three tenants. */
const VECTOR_STORE = DOCUMENTS;

describe("tenant isolation matrix — retrieval filter", () => {
  it("has 3 distinct tenants and 8 users in the fixture", () => {
    expect(TENANTS).toHaveLength(3);
    expect(USERS).toHaveLength(8);
    expect(new Set(TENANTS.map((t) => t.tenantId)).size).toBe(3);
  });

  it("every document's key encodes its tenant and plain department consistently", () => {
    for (const doc of DOCUMENTS) {
      const [tenant, plainDepartment] = doc.key.split("/");
      expect(tenant).toBe(doc.tenantId);
      expect(plainDepartment).toBe(doc.plainDepartment);
      // The namespaced department is derived from tenant + plain name.
      expect(doc.department).toBe(`${doc.tenantId}:${doc.plainDepartment}`);
    }
  });

  describe.each(USERS.map((u) => [u.email, u] as const))(
    "user %s",
    (_email, user) => {
      const filter = buildRetrievalFilter(user.tenantId, user.departments);
      const visible = applyFilter(filter, VECTOR_STORE);

      it("sees only documents from their own tenant", () => {
        for (const doc of visible) {
          expect(doc.tenantId).toBe(user.tenantId);
        }
      });

      it("sees their own department's documents", () => {
        const ownDept = user.departments.filter((d) => !d.endsWith(":org-wide"));
        for (const dept of ownDept) {
          const docs = visible.filter((d) => d.department === dept);
          expect(docs.length).toBeGreaterThan(0);
        }
      });

      it("sees their tenant's org-wide documents", () => {
        const orgWide = visible.filter((d) => d.department === `${user.tenantId}:org-wide`);
        expect(orgWide.length).toBeGreaterThan(0);
      });

      it("never sees another department in the SAME tenant", () => {
        const otherDepts = TENANTS.find((t) => t.tenantId === user.tenantId)!
          .departments.map((d) => `${user.tenantId}:${d}`)
          .filter((d) => !user.departments.includes(d));
        for (const doc of visible) {
          expect(otherDepts).not.toContain(doc.department);
        }
      });

      it("never sees ANY document from a DIFFERENT tenant", () => {
        const foreignTenants = TENANTS.filter((t) => t.tenantId !== user.tenantId).map(
          (t) => t.tenantId
        );
        for (const doc of visible) {
          expect(foreignTenants).not.toContain(doc.tenantId);
        }
      });
    }
  );
});

describe("tenant isolation matrix — cross-tenant / cross-department queries", () => {
  // Concrete adversarial scenarios: a user explicitly asks for content that
  // belongs to another department or another company.

  it("alice (acme engineering) cannot retrieve acme finance content", () => {
    const alice = userByEmail("alice@acme.com");
    const budget = documentByTopic("FY2026 budget");
    const filter = buildRetrievalFilter(alice.tenantId, alice.departments);
    const visible = applyFilter(filter, VECTOR_STORE);
    expect(visible).not.toContainEqual(budget);
  });

  it("alice (acme engineering) cannot retrieve globex sales content", () => {
    const alice = userByEmail("alice@acme.com");
    const salesPlan = documentByTopic("Q3 sales plan");
    const filter = buildRetrievalFilter(alice.tenantId, alice.departments);
    const visible = applyFilter(filter, VECTOR_STORE);
    expect(visible).not.toContainEqual(salesPlan);
  });

  it("dave (globex sales) cannot retrieve initech engineering content", () => {
    const dave = userByEmail("dave@globex.com");
    const tps = documentByTopic("TPS report format");
    const filter = buildRetrievalFilter(dave.tenantId, dave.departments);
    const visible = applyFilter(filter, VECTOR_STORE);
    expect(visible).not.toContainEqual(tps);
  });

  it("grace (initech engineering) cannot retrieve acme engineering content", () => {
    const grace = userByEmail("grace@initech.com");
    const atlas = documentByTopic("Project Atlas architecture");
    const filter = buildRetrievalFilter(grace.tenantId, grace.departments);
    const visible = applyFilter(filter, VECTOR_STORE);
    expect(visible).not.toContainEqual(atlas);
  });

  it("bob (acme finance) CAN retrieve acme finance content", () => {
    const bob = userByEmail("bob@acme.com");
    const budget = documentByTopic("FY2026 budget");
    const filter = buildRetrievalFilter(bob.tenantId, bob.departments);
    const visible = applyFilter(filter, VECTOR_STORE);
    expect(visible).toContainEqual(budget);
  });

  it("every user can retrieve their own tenant's org-wide content", () => {
    for (const user of USERS) {
      const filter = buildRetrievalFilter(user.tenantId, user.departments);
      const visible = applyFilter(filter, VECTOR_STORE);
      const orgWide = visible.filter((d) => d.department === `${user.tenantId}:org-wide`);
      expect(orgWide.length).toBeGreaterThan(0);
    }
  });
});

describe("tenant isolation matrix — citation presign re-check", () => {
  // Even if a cross-tenant citation somehow reached the presign step, the
  // tenant re-check must suppress it (defense-in-depth).

  it("alice (acme) cannot mint a presigned URL for a globex document", async () => {
    const alice = userByEmail("alice@acme.com");
    const salesPlan = documentByTopic("Q3 sales plan");
    const link = await presignCitation(
      s3,
      BUCKET,
      `s3://${BUCKET}/${salesPlan.key}`,
      "ref-globex",
      alice.tenantId,
      alice.departments
    );
    expect(link).toBeNull();
  });

  it("alice (acme) cannot mint a presigned URL for acme finance (other dept)", async () => {
    const alice = userByEmail("alice@acme.com");
    const budget = documentByTopic("FY2026 budget");
    const link = await presignCitation(
      s3,
      BUCKET,
      `s3://${BUCKET}/${budget.key}`,
      "ref-finance",
      alice.tenantId,
      alice.departments
    );
    expect(link).toBeNull();
  });

  it("alice (acme) CAN mint a presigned URL for her own engineering doc", async () => {
    const alice = userByEmail("alice@acme.com");
    const atlas = documentByTopic("Project Atlas architecture");
    const link = await presignCitation(
      s3,
      BUCKET,
      `s3://${BUCKET}/${atlas.key}`,
      "ref-eng",
      alice.tenantId,
      alice.departments
    );
    expect(link).not.toBeNull();
    expect(link!.referenceId).toBe("ref-eng");
  });

  it("alice (acme) CAN mint a presigned URL for acme org-wide content", async () => {
    const alice = userByEmail("alice@acme.com");
    const mission = documentByTopic("company mission statement");
    const link = await presignCitation(
      s3,
      BUCKET,
      `s3://${BUCKET}/${mission.key}`,
      "ref-orgwide",
      alice.tenantId,
      alice.departments
    );
    expect(link).not.toBeNull();
  });

  it("s3UriToKey correctly strips the bucket for tenant-scoped keys", () => {
    const key = s3UriToKey(`s3://${BUCKET}/acme-com/engineering/doc.pdf`);
    expect(key).toBe("acme-com/engineering/doc.pdf");
  });
});
