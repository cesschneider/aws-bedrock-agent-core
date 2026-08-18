import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { namespacedDepartment, userCanAccessDepartment } from "../common/auth";

/**
 * Citation download links (spec Section 4.4 + multi-tenant design §4.4):
 * every citation resolves to a presigned S3 URL, and the requesting user's
 * tenant AND department access is re-validated at link-generation time —
 * not just at query time — so a user who lost access mid-session can't mint
 * fresh links from a stale citation.
 *
 * Uploaded objects are keyed `{tenantId}/{department}/{uuid}-{filename}`
 * (lambda/upload-handler buildObjectKey), so:
 *   - the tenant is the FIRST path segment
 *   - the department is the SECOND path segment
 */

const PRESIGNED_URL_EXPIRY_SECONDS = 300; // short-lived, links are per-answer

export interface CitationLink {
  referenceId: string;
  url: string;
}

export function s3UriToKey(s3Uri: string): string {
  return s3Uri.replace(/^s3:\/\/[^/]+\//, "").replace(/^arn:aws:s3:::[^/]+\//, "");
}

export function tenantFromKey(key: string): string {
  return key.split("/")[0] ?? "";
}

export function departmentFromKey(key: string): string {
  return key.split("/")[1] ?? "";
}

export async function presignCitation(
  s3: S3Client,
  bucket: string,
  s3Uri: string,
  referenceId: string,
  userTenantId: string,
  userDepartments: string[]
): Promise<CitationLink | null> {
  const key = s3UriToKey(s3Uri);
  const citationTenant = tenantFromKey(key);
  const plainDepartment = departmentFromKey(key);
  // The S3 key carries the human-facing department name; the user's claims
  // are tenant-namespaced. Namespace the citation's department before the
  // access check so `acme-com:engineering` matches `acme-com:engineering`.
  const department = namespacedDepartment(citationTenant, plainDepartment);

  // Tenant re-check (multi-tenant design §4.4): a citation from a
  // different tenant must NEVER produce a presigned URL, regardless of
  // what the vector search returned. This is defense-in-depth — the
  // retrieval filter should already prevent cross-tenant hits.
  if (!userTenantId || citationTenant !== userTenantId) {
    return null;
  }

  // Department re-check (spec 4.4). A citation for a department the user
  // no longer belongs to is silently omitted rather than erroring the
  // whole answer.
  if (!userCanAccessDepartment(userDepartments, department)) {
    return null;
  }

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: PRESIGNED_URL_EXPIRY_SECONDS }
  );
  return { referenceId, url };
}

