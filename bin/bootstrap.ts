#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { GitHubOidcStack } from "../lib/bootstrap/github-oidc-stack";

const app = new cdk.App();

new GitHubOidcStack(app, "GitHubOidcBootstrap", {
  githubRepo: "cesschneider/aws-bedrock-agent-core",
  // Only main branch pushes may assume this role — PRs from forks or other
  // branches cannot deploy. Tighten further (e.g. environment: prod) if you
  // add a separate prod-specific role later.
  allowedRefs: ["ref:refs/heads/main"],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
