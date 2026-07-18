import { google } from "googleapis";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type { GroupsFetcher } from "./index";

/**
 * Fetches a user's Google Workspace group memberships via the Admin SDK
 * Directory API.
 *
 * Requires a Google Workspace service account with domain-wide delegation
 * granted the `https://www.googleapis.com/auth/admin.directory.group.readonly`
 * scope, impersonating a Workspace admin. This is a one-time manual setup
 * step in the Google Workspace Admin console — see docs/deployment-setup.md.
 *
 * The service account key JSON is stored as an SSM SecureString parameter
 * (tech decision: SSM Parameter Store for secrets), never in code or env vars.
 */
export class GoogleAdminGroupsFetcher implements GroupsFetcher {
  private readonly ssm: SSMClient;
  private readonly serviceAccountKeyParam: string;
  private readonly impersonatedAdminEmail: string;

  constructor(
    ssm: SSMClient = new SSMClient({}),
    serviceAccountKeyParam: string = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PARAM ?? "",
    impersonatedAdminEmail: string = process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL ?? ""
  ) {
    this.ssm = ssm;
    this.serviceAccountKeyParam = serviceAccountKeyParam;
    this.impersonatedAdminEmail = impersonatedAdminEmail;
  }

  async fetchGroupsForUser(email: string): Promise<string[]> {
    if (!this.serviceAccountKeyParam || !this.impersonatedAdminEmail) {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_KEY_PARAM and GOOGLE_WORKSPACE_ADMIN_EMAIL must be set"
      );
    }

    const keyJson = await this.loadServiceAccountKey();
    const auth = new google.auth.JWT({
      email: keyJson.client_email,
      key: keyJson.private_key,
      scopes: ["https://www.googleapis.com/auth/admin.directory.group.readonly"],
      subject: this.impersonatedAdminEmail,
    });

    const admin = google.admin({ version: "directory_v1", auth });
    const response = await admin.groups.list({ userKey: email });
    return (response.data.groups ?? []).map((group) => group.email).filter((e): e is string => Boolean(e));
  }

  private async loadServiceAccountKey(): Promise<{ client_email: string; private_key: string }> {
    const result = await this.ssm.send(
      new GetParameterCommand({ Name: this.serviceAccountKeyParam, WithDecryption: true })
    );
    const value = result.Parameter?.Value;
    if (!value) {
      throw new Error(`SSM parameter ${this.serviceAccountKeyParam} has no value`);
    }
    return JSON.parse(value);
  }
}
