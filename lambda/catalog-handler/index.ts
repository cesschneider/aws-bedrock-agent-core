import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  deleteCatalogItem,
  getCatalogItem,
  isValidName,
  listCatalog,
  normalizeName,
  putCatalogItem,
  type CatalogKind,
} from "../common/catalog-store";
import { getTenant } from "../common/tenant-registry";
import { isTenantAdmin } from "../common/membership-store";
import { domainFromEmail } from "../common/auth";

/**
 * Per-tenant department + tag catalog API.
 *
 * Exposes the admin-managed lists that drive the UI dropdowns and tag
 * normalization:
 *   GET    /catalog/departments          — list departments
 *   POST   /catalog/departments          — create a department (admin)
 *   DELETE /catalog/departments/{name}   — delete a department (admin)
 *   GET    /catalog/tags                 — list normalized tags
 *   POST   /catalog/tags                 — create a tag (admin)
 *   DELETE /catalog/tags/{name}          — delete a tag (admin)
 *
 * List operations are available to any authenticated member of the tenant;
 * create/delete are restricted to the tenant's admin (the email recorded in
 * the tenant registry at provisioning time).
 */

const dynamo = new DynamoDBClient({});
const tableName = process.env.TENANT_CATALOG_TABLE_NAME ?? "";
const tenantRegistryTable = process.env.TENANT_REGISTRY_TABLE_NAME ?? "";
const membershipTable = process.env.TENANT_MEMBERSHIP_TABLE_NAME ?? "";
const envName = process.env.ENV_NAME ?? "";

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

interface AuthContext {
  tenantId: string;
  email: string;
}

function authFromEvent(event: APIGatewayProxyEventV2WithJWTAuthorizer): AuthContext {
  const claims = event.requestContext.authorizer.jwt.claims as Record<string, string>;
  const tenantId = claims["custom:tenantId"];
  if (!tenantId || tenantId.trim().length === 0) {
    throw Object.assign(new Error("Missing tenant claim (custom:tenantId)"), { statusCode: 401 });
  }
  const email = claims["email"] ?? "";
  return { tenantId: tenantId.trim(), email };
}

/**
 * A caller is an admin when their membership record (or, for the provisioning
 * admin, the tenant registry) marks them as admin. Fails closed: if neither
 * source resolves the caller as admin, they are not admin.
 *
 * Exception: the `dev` tenant is a native-user test tenant (no registry
 * record, single test user) that only exists in non-prd environments. Any
 * authenticated member of the `dev` tenant is treated as admin so the admin
 * UI can be exercised end-to-end in dev/stg.
 */
async function isAdmin(tenantId: string, email: string): Promise<boolean> {
  // The `dev` tenant is a native-user test tenant (no registry record) that
  // only exists in non-prd environments. Any authenticated member of the
  // `dev` tenant is treated as admin so the admin UI can be exercised
  // end-to-end in dev/stg. Gated on ENV_NAME so it can never apply in prd.
  if (tenantId === "dev" && envName !== "prd") return true;

  // Membership-first: an ACTIVE admin membership is authoritative.
  if (membershipTable && email) {
    if (await isTenantAdmin(dynamo, membershipTable, tenantId, email)) return true;
  }

  // Fallback: the tenant registry's recorded adminEmail (provisioning admin).
  if (!tenantRegistryTable || !email) return false;
  let domain: string;
  try {
    domain = domainFromEmail(email);
  } catch {
    return false;
  }
  const record = await getTenant(dynamo, tenantRegistryTable, domain);
  if (!record) return false;
  return record.tenantId === tenantId && record.adminEmail.toLowerCase() === email.toLowerCase();
}

function kindFromPath(segment: string): CatalogKind | undefined {
  if (segment === "departments") return "department";
  if (segment === "tags") return "tag";
  return undefined;
}

async function handleList(
  auth: AuthContext,
  kind: CatalogKind
): Promise<APIGatewayProxyStructuredResultV2> {
  const items = await listCatalog(dynamo, tableName, auth.tenantId, kind);
  return json(200, { [kind === "department" ? "departments" : "tags"]: items.map((i) => i.name) });
}

async function handleCreate(
  auth: AuthContext,
  kind: CatalogKind,
  rawName: string
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(auth.tenantId, auth.email))) {
    return json(403, { error: "Only the tenant admin can manage the catalog" });
  }
  const name = normalizeName(rawName);
  if (!isValidName(name)) {
    return json(400, {
      error: "Invalid name: use lowercase letters, digits, hyphens, or underscores (max 64 chars)",
    });
  }
  await putCatalogItem(dynamo, tableName, {
    tenantId: auth.tenantId,
    kind,
    name,
    createdBy: auth.email,
    createdAt: new Date().toISOString(),
  });
  return json(201, { name, kind });
}

async function handleDelete(
  auth: AuthContext,
  kind: CatalogKind,
  rawName: string
): Promise<APIGatewayProxyStructuredResultV2> {
  if (!(await isAdmin(auth.tenantId, auth.email))) {
    return json(403, { error: "Only the tenant admin can manage the catalog" });
  }
  const name = normalizeName(rawName);
  const existing = await getCatalogItem(dynamo, tableName, auth.tenantId, kind, name);
  if (!existing) {
    return json(404, { error: `${kind} "${name}" not found` });
  }
  await deleteCatalogItem(dynamo, tableName, auth.tenantId, kind, name);
  return json(200, { deleted: true, name, kind });
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> => {
  if (!tableName) {
    return json(500, { error: "TENANT_CATALOG_TABLE_NAME is required" });
  }

  try {
    const auth = authFromEvent(event);
    const method = event.requestContext.http.method;
    const path = event.rawPath ?? event.requestContext.http.path ?? "";
    const segments = path.split("/").filter(Boolean); // e.g. ["catalog", "departments", "<name>"]

    // GET /catalog/departments | /catalog/tags
    if (method === "GET" && segments.length === 2 && segments[0] === "catalog") {
      const kind = kindFromPath(segments[1]);
      if (kind) return await handleList(auth, kind);
    }

    // POST /catalog/departments | /catalog/tags  (body: { name })
    if (method === "POST" && segments.length === 2 && segments[0] === "catalog") {
      const kind = kindFromPath(segments[1]);
      if (kind) {
        const body = JSON.parse(event.body ?? "{}") as { name?: string };
        if (!body.name || typeof body.name !== "string") {
          return json(400, { error: "name is required" });
        }
        return await handleCreate(auth, kind, body.name);
      }
    }

    // DELETE /catalog/departments/{name} | /catalog/tags/{name}
    if (method === "DELETE" && segments.length === 3 && segments[0] === "catalog") {
      const kind = kindFromPath(segments[1]);
      if (kind) return await handleDelete(auth, kind, decodeURIComponent(segments[2]));
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    console.error("Catalog handler error:", err);
    const e = err as { statusCode?: number; message?: string };
    return json(e.statusCode ?? 500, { error: e.message ?? "Internal server error" });
  }
};
