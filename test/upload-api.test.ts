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

  it("protects POST /uploads with the dual-issuer Lambda authorizer", () => {
    const template = synthDev();
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "REQUEST",
      EnableSimpleResponses: true,
    });
    const routes = JSON.stringify(template.findResources("AWS::ApiGatewayV2::Route"));
    expect(routes).toContain("POST /uploads");
    // The route must reference the authorizer, not be open.
    expect(routes).toContain("AuthorizerId");
  });

  it("points the authorizer at the shared dual-issuer Lambda", () => {
    const template = synthDev();
    const authorizers = JSON.stringify(template.findResources("AWS::ApiGatewayV2::Authorizer"));
    expect(authorizers).toContain("DualIssuerAuthorizerAuthorizerFn");
    expect(authorizers).toContain("lambda:path/2015-03-31/functions");
  });

  it("configures CORS on the raw-documents bucket so the browser can POST directly to S3", () => {
    const template = synthDev();
    template.hasResourceProperties("AWS::S3::Bucket", {
      CorsConfiguration: {
        CorsRules: [
          {
            AllowedMethods: ["POST"],
            AllowedOrigins: ["*"],
            AllowedHeaders: ["*"],
            MaxAge: 3000,
          },
        ],
      },
    });
  });
});

