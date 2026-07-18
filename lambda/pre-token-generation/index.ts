import type { PreTokenGenerationV2TriggerEvent } from "aws-lambda";
import { COMPANY_WIDE } from "../common/auth";
import { GoogleAdminGroupsFetcher } from "./google-admin-groups-fetcher";

export interface GroupsFetcher {
  /** Returns the Google Workspace group emails the user belongs to. */
  fetchGroupsForUser(email: string): Promise<string[]>;
}

/**
 * Maps Google Workspace group emails (e.g. "dept-engineering@company.com")
 * to department names (spec Section 4.1: "one Workspace group ↔ one
 * department"), always including the reserved company-wide department.
 */
export function mapWorkspaceGroupsToDepartments(workspaceGroupEmails: string[]): string[] {
  const departments = workspaceGroupEmails
    .map((email) => email.split("@")[0])
    .filter((localPart): localPart is string => Boolean(localPart) && localPart.length > 0);
  return Array.from(new Set([...departments, COMPANY_WIDE]));
}

export async function buildGroupOverride(
  event: PreTokenGenerationV2TriggerEvent,
  groupsFetcher: GroupsFetcher
): Promise<PreTokenGenerationV2TriggerEvent> {
  const email = event.request.userAttributes.email;
  if (!email) {
    throw new Error("Pre-token-generation event is missing the user's email attribute");
  }

  const workspaceGroups = await groupsFetcher.fetchGroupsForUser(email);
  const departments = mapWorkspaceGroupsToDepartments(workspaceGroups);

  event.response = {
    claimsAndScopeOverrideDetails: {
      groupOverrideDetails: {
        groupsToOverride: departments,
      },
    },
  };

  return event;
}

// Real Google Admin SDK wiring — requires a Workspace service account with
// domain-wide delegation for the Admin SDK Directory API's
// admin.directory.group.readonly scope. This is a one-time manual setup
// step in the Google Workspace Admin console (not something CDK/IAM can
// automate), documented in docs/deployment-setup.md follow-up. Until that
// setup exists, this fetcher will fail at runtime — it is not exercised by
// unit tests, which cover buildGroupOverride/mapWorkspaceGroupsToDepartments
// against fake fetchers instead.
const googleAdminGroupsFetcher = new GoogleAdminGroupsFetcher();

export const handler = async (
  event: PreTokenGenerationV2TriggerEvent
): Promise<PreTokenGenerationV2TriggerEvent> => {
  return buildGroupOverride(event, googleAdminGroupsFetcher);
};
