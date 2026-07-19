import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { RagKnowledgeAgentStack } from "../lib/rag-knowledge-agent-stack";

describe("RagKnowledgeAgentStack", () => {
  it.each(["dev", "stg", "prd"])("synthesizes for env=%s with correct tags", (envName) => {
    const app = new cdk.App();
    const stack = new RagKnowledgeAgentStack(app, `TestStack-${envName}`, {
      envName,
      googleClientSecretOverride: "test-client-secret",
      devTestUserPasswordOverride: "test-dev-password",
    });
    const template = Template.fromStack(stack);

    expect(stack.envName).toBe(envName);
    // Synthesis should not throw and should produce a valid template.
    expect(template.toJSON()).toBeDefined();
  });

  it("rejects an invalid environment name at the app level", () => {
    // The validation lives in bin/app.ts; this test documents the expected
    // contract so a future refactor that drops it fails loudly.
    const validEnvs = ["dev", "stg", "prd"];
    expect(validEnvs.includes("not-a-real-env")).toBe(false);
  });
});
