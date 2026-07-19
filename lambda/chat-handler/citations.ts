import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { userCanAccessDepartment } from "../common/auth";

/**
 * Citation download links (spec Section 4.4): every citation resolves to a
 * presigned S3 URL, and the requesting user's department access is
 * re-validated at link-generation time — not just at query time — so a user
 * who lost department access mid-session can't mint fresh links from a
 * stale citation.
 *
 * Uploaded objects are keyed `{department}/{uuid}-{filename}`
 * (lambda/upload-handler buildObjectKey), so the department a document
 * belongs to is the first path segment of its S3 key.
 */

const PRESIGNED_URL_EXPIRY_SECONDS = 300; // short-lived, links are per-answer

export interface CitationLink {
  referenceId: string;
  url: string;
}

export function s3UriToKey(s3Uri: string): string {
  return s3Uri.replace(/^s3:\/\/[^/]+\//, "").replace(/^arn:aws:s3:::[^/]+\//, "");
}

export function departmentFromKey(key: string): string {
  return key.split("/")[0] ?? "";
}

export async function presignCitation(
  s3: S3Client,
  bucket: string,
  s3Uri: string,
  referenceId: string,
  userDepartments: string[]
): Promise<CitationLink | null> {
  const key = s3UriToKey(s3Uri);
  const department = departmentFromKey(key);

  // Link-generation-time access re-check (spec 4.4). A citation for a
  // department the user no longer belongs to is silently omitted rather
  // than erroring the whole answer.
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
