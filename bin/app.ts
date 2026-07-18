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

new RagKnowledgeAgentStack(app, `RagKnowledgeAgent-${envName}`, {
  envName,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
