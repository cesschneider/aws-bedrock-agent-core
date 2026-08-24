import {
  DynamoDBClient,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

/**
 * Shared tenant-membership access (multi-user support).
 *
 * Maps a user's email to exactly one tenant with a role and status. This is
 * the source of truth for:
 *   - tenant resolution at login (pre-token-generation) — membership first,
 *     falling back to the domain→tenant registry for the provisioning admin;
 *   - admin authorization (catalog/members management) — role === "admin";
 *   - the invitation flow (invite → accept → active member).
 */

export type MemberRole = "admin" | "member";
export type MemberStatus = "PENDING" | "ACTIVE";

export interface MemberRecord {
  email: string;
  tenantId: string;
  role: MemberRole;
  status: MemberStatus;
  /** Departments assigned to this member (tenant-namespaced, e.g. ["dept-engineering"]). */
  departments: string[];
  invitedBy?: string;
  invitedAt?: string;
  acceptedAt?: string;
}

export class MembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MembershipError";
  }
}

function fromItem(item: Record<string, AttributeValue> | undefined): MemberRecord | undefined {
  if (!item) return undefined;
  const rawDepts = item.departments?.SS ?? [];
  return {
    email: item.email.S as string,
    tenantId: item.tenantId.S as string,
    role: item.role.S as MemberRole,
    status: item.status.S as MemberStatus,
    departments: rawDepts,
    invitedBy: item.invitedBy?.S,
    invitedAt: item.invitedAt?.S,
    acceptedAt: item.acceptedAt?.S,
  };
}

export async function getMember(
  dynamo: DynamoDBClient,
  tableName: string,
  email: string
): Promise<MemberRecord | undefined> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { email: { S: email.toLowerCase() } },
    })
  );
  return fromItem(result.Item);
}

export async function listMembers(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string
): Promise<MemberRecord[]> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "tenantId-index",
      KeyConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":tenantId": { S: tenantId } },
    })
  );
  return (result.Items ?? []).map(fromItem).filter((m): m is MemberRecord => Boolean(m));
}

/**
 * Creates a PENDING invitation. Fails if the email is already a member of any
 * tenant (a user belongs to exactly one tenant).
 */
export async function inviteMember(
  dynamo: DynamoDBClient,
  tableName: string,
  input: { email: string; tenantId: string; invitedBy: string }
): Promise<MemberRecord> {
  const email = input.email.toLowerCase();
  const record: MemberRecord = {
    email,
    tenantId: input.tenantId,
    role: "member",
    status: "PENDING",
    departments: [],
    invitedBy: input.invitedBy,
    invitedAt: new Date().toISOString(),
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        email: { S: record.email },
        tenantId: { S: record.tenantId },
        role: { S: record.role },
        status: { S: record.status },
        invitedBy: { S: record.invitedBy ?? "" },
        invitedAt: { S: record.invitedAt ?? "" },
      },
      ConditionExpression: "attribute_not_exists(email)",
    })
  );

  return record;
}

/**
 * Accepts a PENDING invitation, activating the membership. The accepting
 * user's email must match the invitation (enforced by the caller via the JWT
 * email claim). Idempotent: an already-ACTIVE membership returns as-is.
 */
export async function acceptMembership(
  dynamo: DynamoDBClient,
  tableName: string,
  email: string
): Promise<MemberRecord> {
  const existing = await getMember(dynamo, tableName, email);
  if (!existing) {
    throw new MembershipError("No invitation found for this email");
  }
  if (existing.status === "ACTIVE") {
    return existing;
  }

  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { email: { S: email.toLowerCase() } },
      UpdateExpression: "SET #status = :active, acceptedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":active": { S: "ACTIVE" },
        ":now": { S: new Date().toISOString() },
      },
    })
  );

  return { ...existing, status: "ACTIVE", acceptedAt: new Date().toISOString() };
}

/**
 * Creates the first (admin) membership for a tenant at activation time. The
 * provisioning admin is the first user and is always ACTIVE + admin.
 */
export async function createAdminMembership(
  dynamo: DynamoDBClient,
  tableName: string,
  input: { email: string; tenantId: string }
): Promise<MemberRecord> {
  const email = input.email.toLowerCase();
  const record: MemberRecord = {
    email,
    tenantId: input.tenantId,
    role: "admin",
    status: "ACTIVE",
    departments: [],
    acceptedAt: new Date().toISOString(),
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        email: { S: record.email },
        tenantId: { S: record.tenantId },
        role: { S: record.role },
        status: { S: record.status },
        acceptedAt: { S: record.acceptedAt ?? "" },
      },
      ConditionExpression: "attribute_not_exists(email)",
    })
  );

  return record;
}

export async function removeMember(
  dynamo: DynamoDBClient,
  tableName: string,
  email: string
): Promise<void> {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { email: { S: email.toLowerCase() } },
    })
  );
}

/**
 * Resolves a user's tenant from membership. Returns undefined when the user
 * has no membership record (caller falls back to the domain→tenant registry).
 */
export async function resolveTenantFromMembership(
  dynamo: DynamoDBClient,
  tableName: string,
  email: string
): Promise<MemberRecord | undefined> {
  const member = await getMember(dynamo, tableName, email);
  if (!member || member.status !== "ACTIVE") return undefined;
  return member;
}

/**
 * Whether the given email is an admin of the given tenant. Fails closed.
 */
export async function isTenantAdmin(
  dynamo: DynamoDBClient,
  tableName: string,
  tenantId: string,
  email: string
): Promise<boolean> {
  const member = await getMember(dynamo, tableName, email);
  return Boolean(
    member &&
      member.tenantId === tenantId &&
      member.status === "ACTIVE" &&
      member.role === "admin"
  );
}

/**
 * Updates the departments assigned to a member. The caller is responsible for
 * admin authorization and validating that the departments belong to the
 * tenant's catalog. An empty array clears all department assignments.
 */
export async function updateMemberDepartments(
  dynamo: DynamoDBClient,
  tableName: string,
  email: string,
  departments: string[]
): Promise<MemberRecord> {
  const key = { email: { S: email.toLowerCase() } };
  await dynamo.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET departments = :depts",
      ExpressionAttributeValues: {
        ":depts": { SS: departments.length > 0 ? departments : [""] },
      },
    })
  );
  const updated = await getMember(dynamo, tableName, email);
  if (!updated) throw new MembershipError("Member not found after update");
  return updated;
}
