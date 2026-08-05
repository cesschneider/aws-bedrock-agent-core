#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { GitHubOidcStack } from "../lib/bootstrap/github-oidc-stack";

const app = new cdk.App();

new GitHubOidcStack(app, "GitHubOidcBootstrap", {
  githubRepo: "cesschneider/aws-bedrock-agent-core",
  // Branch → environment mapping: development→dev, staging→stg, main→prd.
  // Only explicit branch pushes and matched environment claims may assume
  // this role — PRs from forks or other branches cannot deploy.
  allowedRefs: ["ref:refs/heads/main", "ref:refs/heads/development", "ref:refs/heads/staging"],
  environments: ["dev", "stg", "prd"],
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});

