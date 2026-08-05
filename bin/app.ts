#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { RagKnowledgeAgentStack } from "../lib/rag-knowledge-agent-stack";

const app = new cdk.App();

const envName = app.node.tryGetContext("env") ?? process.env.RAG_ENV ?? "dev";
const validEnvs = ["dev", "stg", "prd"];
if (!validEnvs.includes(envName)) {
  throw new Error(`Invalid env "${envName}" — must be one of: ${validEnvs.join(", ")}`);
}

// valueFromLookup needs a real AWS account context to resolve SSM parameters.
// In CI (synth-only), CDK_DEFAULT_ACCOUNT is unset — pass a placeholder override
// so synth doesn't fail. The deploy workflow always has credentials, so the
// real SSM lookup happens there.
const hasAwsContext = Boolean(process.env.CDK_DEFAULT_ACCOUNT);

// Dev test user password (non-prd only) is passed via CDK context from a
// GitHub Environment secret (DEV_TEST_USER_PASSWORD) at deploy time — see
// .github/workflows/deploy.yml. Absent/empty ⇒ no dev user is created (the
// deploy still succeeds). This avoids a synth-time SSM lookup that would
// hard-fail until the secret exists, which would block all dev deploys.
const devTestUserPassword = nonEmptyContext(app, "dev-test-user-password");

new RagKnowledgeAgentStack(app, `RagKnowledgeAgent-${envName}`, {
  envName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  ...(!hasAwsContext && { googleClientSecretOverride: "ci-synth-placeholder" }),
  ...(devTestUserPassword && { devTestUserPassword }),
});

function nonEmptyContext(app: cdk.App, key: string): string | undefined {
  const v = app.node.tryGetContext(key);
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

