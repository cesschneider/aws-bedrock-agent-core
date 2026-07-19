import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { RagKnowledgeAgentStack } from "../lib/rag-knowledge-agent-stack";

function synthDev(): Template {
  const app = new cdk.App();
  const stack = new RagKnowledgeAgentStack(app, "TestStack-upload-api", {
    envName: "dev",
    googleClientSecretOverride: "test-client-secret",
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("UploadApi", () => {
  it("creates an HTTP API named for the environment", () => {
    const template = synthDev();
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "rag-knowledge-agent-upload-dev",
      ProtocolType: "HTTP",
    });
  });

  it("protects POST /uploads with a Cognito JWT authorizer", () => {
    const template = synthDev();
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
    });
    const routes = JSON.stringify(template.findResources("AWS::ApiGatewayV2::Route"));
    expect(routes).toContain("POST /uploads");
    // The route must reference the authorizer, not be open.
    expect(routes).toContain("JWT");
  });

  it("points the JWT issuer at the stack's Cognito user pool", () => {
    const template = synthDev();
    const authorizers = JSON.stringify(template.findResources("AWS::ApiGatewayV2::Authorizer"));
    expect(authorizers).toContain("cognito-idp.us-east-1.amazonaws.com");
  });
});
