import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { VectorIndex } from "../lib/constructs/vector-index";

function synthWith(envName: string): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, `TestStack-${envName}`, {
    env: { account: "123456789012", region: "us-east-1" },
  });
  new VectorIndex(stack, "VectorIndex", { envName });
  return Template.fromStack(stack);
}

describe("VectorIndex", () => {
  it("creates a vector bucket named for the environment", () => {
    const template = synthWith("dev");
    template.hasResourceProperties("AWS::S3Vectors::VectorBucket", {
      VectorBucketName: "rag-knowledge-agent-vectors-dev",
    });
  });

  it("creates a 1024-dim float32 cosine index matching Titan Embeddings V2", () => {
    const template = synthWith("dev");
    template.hasResourceProperties("AWS::S3Vectors::Index", {
      VectorBucketName: "rag-knowledge-agent-vectors-dev",
      IndexName: "documents",
      DataType: "float32",
      Dimension: 1024,
      DistanceMetric: "cosine",
    });
  });

  it("keeps chunk text non-filterable but department filterable", () => {
    const template = synthWith("dev");
    template.hasResourceProperties("AWS::S3Vectors::Index", {
      MetadataConfiguration: {
        NonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT"],
      },
    });
  });

  it("retains vector resources in prd, destroys elsewhere", () => {
    const prd = synthWith("prd");
    const prdBuckets = prd.findResources("AWS::S3Vectors::VectorBucket");
    expect(Object.values(prdBuckets)[0].DeletionPolicy).toBe("Retain");

    const dev = synthWith("dev");
    const devBuckets = dev.findResources("AWS::S3Vectors::VectorBucket");
    expect(Object.values(devBuckets)[0].DeletionPolicy).toBe("Delete");
  });
});
