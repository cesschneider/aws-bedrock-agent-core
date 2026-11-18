#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { RagKnowledgeAgentStack } from "../lib/rag-knowledge-agent-stack";
import { loadDeploymentConfig, DeploymentConfig } from "../lib/deployment-config";

const app = new cdk.App();

// Load per-client deployment config from a gitignored JSON file.
// Priority: -c deployment=<path> context > DEPLOYMENT_CONFIG env var > fallback to legacy env-based mode.
const deploymentConfigPath =
  app.node.tryGetContext("deployment") ?? process.env.DEPLOYMENT_CONFIG;

let config: DeploymentConfig | undefined;
if (deploymentConfigPath) {
  config = loadDeploymentConfig(deploymentConfigPath as string);
} else {
  // Legacy fallback: env-based mode without per-client config
  const envName = app.node.tryGetContext("env") ?? process.env.RAG_ENV ?? "dev";
  const validEnvs = ["dev", "stg", "prd"];
  if (!validEnvs.includes(envName)) {
    throw new Error(`Invalid env "${envName}" — must be one of: ${validEnvs.join(", ")}`);
  }
  config = {
    clientSlug: "default",
    envName,
    account: process.env.CDK_DEFAULT_ACCOUNT ?? "",
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
    resourcePrefix: "rag-knowledge-agent",
  };
}

const envName = config.envName;

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

// Supabase project ref (Lovable Cloud) — public identifier, not a secret.
// Enables dual-issuer JWT validation in the chat-handler. Passed via CDK
// context (`-c supabase-project-ref=…`) or the SUPABASE_PROJECT_REF env var.
const supabaseProjectRef =
  nonEmptyContext(app, "supabase-project-ref") ??
  process.env.SUPABASE_PROJECT_REF ??
  config.supabaseProjectRef;

const stackName = config.stackName ?? `${config.resourcePrefix}-${envName}`;

const stack = new RagKnowledgeAgentStack(app, stackName, {
  envName,
  resourcePrefix: config.resourcePrefix,
  env: {
    account: config.account || process.env.CDK_DEFAULT_ACCOUNT,
    region: config.region,
  },
  ...(!hasAwsContext && { googleClientSecretOverride: "ci-synth-placeholder" }),
  ...(devTestUserPassword && { devTestUserPassword }),
  ...(supabaseProjectRef && { supabaseProjectRef }),
});

// Apply per-client tags
if (config.tags) {
  for (const [key, value] of Object.entries(config.tags)) {
    cdk.Tags.of(stack).add(key, value);
  }
}

function nonEmptyContext(app: cdk.App, key: string): string | undefined {
  const v = app.node.tryGetContext(key);
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
