import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";

export interface GitHubOidcStackProps extends cdk.StackProps {
  /** e.g. "cesschneider/aws-bedrock-agent-core" */
  githubRepo: string;
  /**
   * Branch refs allowed to assume this role, e.g.
   * ["ref:refs/heads/main"]. Keep this narrow — this role can deploy
   * infrastructure, it should not be assumable from arbitrary branches
   * or forks/PRs.
   *
   * Note: the trust policy automatically adds wildcards around the
   * repo owner/repo name because GitHub injects internal numeric IDs
   * into the OIDC token sub claim (e.g.
   * "repo:cesschneider@46808/aws-bedrock-agent-core@1304470098:ref:refs/heads/main").
   * Without wildcards, StringLike would never match.
   */
  allowedRefs: string[];
  /**
   * GitHub Environment names whose deploy jobs are allowed to assume this
   * role, e.g. ["dev", "stg", "prd"]. When a workflow job declares
   * `environment: <name>`, GitHub emits an `environment:<name>` sub claim
   * instead of the branch-based `ref:refs/heads/...` claim — both must be
   * in the trust policy for deploys to work.
   */
  environments?: string[];
}

/**
 * One-time account bootstrap: registers GitHub Actions as an OIDC identity
 * provider and creates a deploy role GitHub workflows can assume — no
 * long-lived AWS access keys are ever stored in GitHub secrets.
 *
 * This role's own permissions are intentionally minimal: it can only
 * assume the CDK bootstrap roles (`cdk-hnb659fds-*`) that `cdk bootstrap`
 * already creates with the actual deploy/publish permissions. This keeps
 * the GitHub-facing trust boundary small — if this role's trust policy is
 * ever misconfigured, the blast radius is "can assume CDK's own roles",
 * not "has raw CloudFormation/IAM/Lambda/etc permissions directly".
 *
 * DEPLOYMENT OF THIS STACK IS A ONE-TIME, MANUAL, ELEVATED-PERMISSION STEP.
 * It is intentionally not wired into the automated story-by-story CI/CD
 * pipeline — see README/CLAUDE.md for the one-time setup commands.
 */
export class GitHubOidcStack extends cdk.Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, props);

    // Reuse an existing GitHub OIDC provider if one is already registered
    // in this account (only one is allowed per account) — otherwise create
    // it. CDK has no built-in "look up or create" for this, so this stack
    // assumes a fresh account; if the provider already exists, comment out
    // this block and reference it via
    // iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(...) instead.
    const provider = new iam.OpenIdConnectProvider(this, "GitHubOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const [owner, repoName] = props.githubRepo.split("/");
    // GitHub injects internal numeric IDs after the owner and repo name in
    // the OIDC sub claim:
    // "repo:cesschneider@46808/aws-bedrock-agent-core@1304470098:ref:refs/heads/main"
    // Wildcards immediately after the owner and repo name match the IDs:
    // "repo:cesschneider*/aws-bedrock-agent-core*:..."
    const repoPattern = `repo:${owner}*/${repoName}*`;

    // Branch-based claims (push, pull_request triggers without environments).
    const branchClaims = props.allowedRefs.map((ref) => `${repoPattern}:${ref}`);

    // Environment-based claims (workflow jobs with `environment: <name>`).
    const envClaims =
      props.environments?.map((env) => `${repoPattern}:environment:${env}`) ?? [];

    const subClaims = [...branchClaims, ...envClaims];

    this.deployRole = new iam.Role(this, "GitHubActionsDeployRole", {
      roleName: "github-actions-rag-knowledge-agent-deploy",
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": subClaims,
        },
      }),
      description: "Assumed by GitHub Actions to deploy the RAG knowledge agent via CDK",
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // Only permission this role has directly: assume CDK's own bootstrap
    // roles. cdk bootstrap creates these with the qualifier "hnb659fds" by
    // default; deploy permissions live on those roles, not here.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:aws:iam::${cdk.Stack.of(this).account}:role/cdk-hnb659fds-deploy-role-${
            cdk.Stack.of(this).account
          }-${cdk.Stack.of(this).region}`,
          `arn:aws:iam::${cdk.Stack.of(this).account}:role/cdk-hnb659fds-file-publishing-role-${
            cdk.Stack.of(this).account
          }-${cdk.Stack.of(this).region}`,
          `arn:aws:iam::${cdk.Stack.of(this).account}:role/cdk-hnb659fds-image-publishing-role-${
            cdk.Stack.of(this).account
          }-${cdk.Stack.of(this).region}`,
          `arn:aws:iam::${cdk.Stack.of(this).account}:role/cdk-hnb659fds-lookup-role-${
            cdk.Stack.of(this).account
          }-${cdk.Stack.of(this).region}`,
        ],
      })
    );

    new cdk.CfnOutput(this, "DeployRoleArn", { value: this.deployRole.roleArn });
  }
}
