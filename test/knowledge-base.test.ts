import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { KnowledgeBase } from "../lib/constructs/knowledge-base";

const VECTOR_INDEX_ARN =
  "arn:aws:s3vectors:us-east-1:123456789012:bucket/test-vectors/index/test-index";

function synthWith(envName: string): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, `TestStack-${envName}`, {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const bucket = new s3.Bucket(stack, "SourceBucket");
  new KnowledgeBase(stack, "KnowledgeBase", {
    envName,
    sourceBucket: bucket,
    vectorIndexArn: VECTOR_INDEX_ARN,
  });
  return Template.fromStack(stack);
}

describe("KnowledgeBase", () => {
  it("creates a vector knowledge base named for the environment", () => {
    const template = synthWith("dev");
    template.hasResourceProperties("AWS::Bedrock::KnowledgeBase", {
      Name: "rag-knowledge-agent-dev",
      KnowledgeBaseConfiguration: {
        Type: "VECTOR",
      },
    });
  });

  it("uses Titan Text Embeddings V2 as the embedding model", () => {
    const template = synthWith("dev");
    const kbs = template.findResources("AWS::Bedrock::KnowledgeBase");
    const kb = Object.values(kbs)[0];
    const modelArn = JSON.stringify(
      kb.Properties.KnowledgeBaseConfiguration.VectorKnowledgeBaseConfiguration.EmbeddingModelArn
    );
    expect(modelArn).toContain("titan-embed-text-v2");
  });

  it("creates an S3 data source with semantic chunking and RETAIN deletion policy", () => {
    const template = synthWith("dev");
    template.hasResourceProperties("AWS::Bedrock::DataSource", {
      Name: "raw-documents-dev",
      DataDeletionPolicy: "RETAIN",
      DataSourceConfiguration: { Type: "S3" },
      VectorIngestionConfiguration: {
        ChunkingConfiguration: { ChunkingStrategy: "SEMANTIC" },
      },
    });
  });

  it("grants the service role read on the source bucket and s3vectors access", () => {
    const template = synthWith("dev");
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("s3vectors:QueryVectors");
    expect(policies).toContain("s3:GetObject");
    expect(policies).toContain("bedrock:InvokeModel");
  });

  it("scopes the service role trust policy to this account", () => {
    const template = synthWith("dev");
    const roles = JSON.stringify(template.findResources("AWS::IAM::Role"));
    expect(roles).toContain("bedrock.amazonaws.com");
    expect(roles).toContain("aws:SourceAccount");
  });
});
