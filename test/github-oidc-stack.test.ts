import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { GitHubOidcStack } from "../lib/bootstrap/github-oidc-stack";

describe("GitHubOidcStack", () => {
  it("synthesizes an OIDC provider and a deploy role scoped to the given repo/refs", () => {
    const app = new cdk.App();
    const stack = new GitHubOidcStack(app, "TestGitHubOidcStack", {
      githubRepo: "example-org/example-repo",
      allowedRefs: ["ref:refs/heads/main"],
      env: { account: "123456789012", region: "us-east-1" },
    });

    const template = Template.fromStack(stack);

    // CDK's iam.OpenIdConnectProvider synthesizes as a custom resource
    // (backed by a CDK-managed Lambda), not the native CloudFormation
    // AWS::IAM::OIDCProvider type, as of this aws-cdk-lib version.
    template.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 1);
    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "github-actions-rag-knowledge-agent-deploy",
    });

    // The sub claim pattern now includes wildcards around owner/repo to handle
    // GitHub's internal numeric IDs (e.g. "repo:example-org@123/example-repo@456:...").
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain("repo:example-org*/example-repo*:ref:refs/heads/main");
  });
});

