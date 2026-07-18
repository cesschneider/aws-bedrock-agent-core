import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { Identity } from "../lib/constructs/identity";

describe("Identity", () => {
  it("synthesizes a Cognito User Pool with a Google IdP and V2_0 pre-token-generation trigger", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack", { env: { account: "123456789012", region: "us-east-1" } });
    new Identity(stack, "Identity", {
      envName: "dev",
      googleClientSecretParam: "/rag-knowledge-agent/dev/google-client-secret",
      googleClientId: "test-client-id.apps.googleusercontent.com",
      googleServiceAccountKeyParam: "/rag-knowledge-agent/dev/google-service-account-key",
      googleWorkspaceAdminEmail: "admin@company.com",
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "rag-knowledge-agent-dev",
      LambdaConfig: Match.objectLike({
        PreTokenGenerationConfig: Match.objectLike({ LambdaVersion: "V2_0" }),
      }),
    });

    template.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderType: "Google",
    });

    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["Google"],
      AllowedOAuthFlows: ["code"],
    });
  });
});
