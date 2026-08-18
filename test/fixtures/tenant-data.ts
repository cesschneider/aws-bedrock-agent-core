/**
 * Sample multi-tenant data fixture for isolation testing.
 *
 * Three tenants, each with multiple departments and a set of documents.
 * Used by `test/tenant-isolation-matrix.test.ts` to validate that:
 *   - a user can retrieve content from their OWN department
 *   - a user CANNOT retrieve content from another department in the SAME tenant
 *   - a user CANNOT retrieve content from ANY department in a DIFFERENT tenant
 *   - org-wide content is visible to every user of the same tenant (and only that tenant)
 *
 * Tenant IDs follow the registry convention (`tenantIdFromDomain`): dots → dashes.
 */

export interface TenantFixture {
  tenantId: string;
  domain: string;
  name: string;
  departments: string[];
}

export interface UserFixture {
  email: string;
  tenantId: string;
  /** Namespaced departments the user belongs to, e.g. `acme-com:engineering`. */
  departments: string[];
}

export interface DocumentFixture {
  /** S3 object key: `{tenantId}/{plainDepartment}/{uuid}-{filename}`. */
  key: string;
  tenantId: string;
  /** Human-facing department name (the S3 key's 2nd segment), e.g. `engineering`. */
  plainDepartment: string;
  /** Tenant-namespaced department (metadata + filter value), e.g. `acme-com:engineering`. */
  department: string;
  /** A unique topic string that only this document can answer. */
  topic: string;
  /** The grounded answer the agent would return for this document. */
  answer: string;
}

export const TENANTS: TenantFixture[] = [
  {
    tenantId: "acme-com",
    domain: "acme.com",
    name: "Acme Corporation",
    departments: ["engineering", "finance", "hr"],
  },
  {
    tenantId: "globex-com",
    domain: "globex.com",
    name: "Globex Industries",
    departments: ["sales", "marketing", "legal"],
  },
  {
    tenantId: "initech-com",
    domain: "initech.com",
    name: "Initech",
    departments: ["engineering", "operations"],
  },
];

export const USERS: UserFixture[] = [
  // Acme users
  {
    email: "alice@acme.com",
    tenantId: "acme-com",
    departments: ["acme-com:engineering", "acme-com:org-wide"],
  },
  {
    email: "bob@acme.com",
    tenantId: "acme-com",
    departments: ["acme-com:finance", "acme-com:org-wide"],
  },
  {
    email: "carol@acme.com",
    tenantId: "acme-com",
    departments: ["acme-com:hr", "acme-com:org-wide"],
  },
  // Globex users
  {
    email: "dave@globex.com",
    tenantId: "globex-com",
    departments: ["globex-com:sales", "globex-com:org-wide"],
  },
  {
    email: "erin@globex.com",
    tenantId: "globex-com",
    departments: ["globex-com:marketing", "globex-com:org-wide"],
  },
  {
    email: "frank@globex.com",
    tenantId: "globex-com",
    departments: ["globex-com:legal", "globex-com:org-wide"],
  },
  // Initech users
  {
    email: "grace@initech.com",
    tenantId: "initech-com",
    departments: ["initech-com:engineering", "initech-com:org-wide"],
  },
  {
    email: "heidi@initech.com",
    tenantId: "initech-com",
    departments: ["initech-com:operations", "initech-com:org-wide"],
  },
];

export const DOCUMENTS: DocumentFixture[] = [
  // ── Acme ────────────────────────────────────────────────────────────────
  {
    key: "acme-com/engineering/11111111-1111-1111-1111-111111111111-architecture.pdf",
    tenantId: "acme-com",
    plainDepartment: "engineering",
    department: "acme-com:engineering",
    topic: "Project Atlas architecture",
    answer: "Project Atlas uses a serverless event-driven architecture.",
  },
  {
    key: "acme-com/finance/22222222-2222-2222-2222-222222222222-budget.pdf",
    tenantId: "acme-com",
    plainDepartment: "finance",
    department: "acme-com:finance",
    topic: "FY2026 budget",
    answer: "The FY2026 budget allocates $12M to R&D.",
  },
  {
    key: "acme-com/hr/33333333-3333-3333-3333-333333333333-handbook.pdf",
    tenantId: "acme-com",
    plainDepartment: "hr",
    department: "acme-com:hr",
    topic: "employee handbook",
    answer: "The employee handbook specifies 25 days of PTO.",
  },
  {
    key: "acme-com/org-wide/44444444-4444-4444-4444-444444444444-mission.pdf",
    tenantId: "acme-com",
    plainDepartment: "org-wide",
    department: "acme-com:org-wide",
    topic: "company mission statement",
    answer: "Acme's mission is to build reliable infrastructure.",
  },

  // ── Globex ──────────────────────────────────────────────────────────────
  {
    key: "globex-com/sales/55555555-5555-5555-5555-555555555555-q3-plan.pdf",
    tenantId: "globex-com",
    plainDepartment: "sales",
    department: "globex-com:sales",
    topic: "Q3 sales plan",
    answer: "The Q3 sales plan targets $5M in new bookings.",
  },
  {
    key: "globex-com/marketing/66666666-6666-6666-6666-666666666666-brand.pdf",
    tenantId: "globex-com",
    plainDepartment: "marketing",
    department: "globex-com:marketing",
    topic: "brand guidelines",
    answer: "Globex brand guidelines mandate the cobalt blue palette.",
  },
  {
    key: "globex-com/legal/77777777-7777-7777-7777-777777777777-nda.pdf",
    tenantId: "globex-com",
    plainDepartment: "legal",
    department: "globex-com:legal",
    topic: "NDA template",
    answer: "The standard NDA has a 3-year confidentiality term.",
  },
  {
    key: "globex-com/org-wide/88888888-8888-8888-8888-888888888888-values.pdf",
    tenantId: "globex-com",
    plainDepartment: "org-wide",
    department: "globex-com:org-wide",
    topic: "company values",
    answer: "Globex values are integrity, speed, and customer obsession.",
  },

  // ── Initech ─────────────────────────────────────────────────────────────
  {
    key: "initech-com/engineering/99999999-9999-9999-9999-999999999999-tps.pdf",
    tenantId: "initech-com",
    plainDepartment: "engineering",
    department: "initech-com:engineering",
    topic: "TPS report format",
    answer: "TPS reports require the new cover sheet.",
  },
  {
    key: "initech-com/operations/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-shift.pdf",
    tenantId: "initech-com",
    plainDepartment: "operations",
    department: "initech-com:operations",
    topic: "shift schedule",
    answer: "Operations runs three 8-hour shifts daily.",
  },
  {
    key: "initech-com/org-wide/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-policy.pdf",
    tenantId: "initech-com",
    plainDepartment: "org-wide",
    department: "initech-com:org-wide",
    topic: "remote work policy",
    answer: "Initech allows 3 remote days per week.",
  },
];

/** Look up a user by email. */
export function userByEmail(email: string): UserFixture {
  const user = USERS.find((u) => u.email === email);
  if (!user) throw new Error(`Unknown user: ${email}`);
  return user;
}

/** Look up a document by its unique topic. */
export function documentByTopic(topic: string): DocumentFixture {
  const doc = DOCUMENTS.find((d) => d.topic === topic);
  if (!doc) throw new Error(`Unknown document topic: ${topic}`);
  return doc;
}
