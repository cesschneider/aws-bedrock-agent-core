import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface VectorIndexProps {
  envName: string;
}

/**
 * S3 Vectors bucket + index backing the Bedrock Knowledge Base
 * (spec Section 5a; Phase 0 spike outcome).
 *
 * Provisioned as CloudFormation resources (AWS::S3Vectors::VectorBucket /
 * AWS::S3Vectors::Index) via CfnResource because aws-cdk-lib has no L2 for
 * S3 Vectors yet. All resources in this project are IaC-managed — no
 * CLI-created resources, ever (environment rule).
 *
 * Index geometry matches the embedding model: Titan Text Embeddings V2
 * emits 1024-dim float32 vectors; cosine distance is Bedrock KB's default
 * for Titan. Changing either requires re-ingesting all documents, so both
 * are deliberately hard-coded next to the embedding model choice in
 * knowledge-base.ts rather than exposed as props.
 */
export class VectorIndex extends Construct {
  public readonly vectorBucket: cdk.CfnResource;
  public readonly index: cdk.CfnResource;
  public readonly indexArn: string;

  constructor(scope: Construct, id: string, props: VectorIndexProps) {
    super(scope, id);

    const bucketName = `rag-knowledge-agent-vectors-${props.envName}`;
    const indexName = "documents";

    this.vectorBucket = new cdk.CfnResource(this, "VectorBucket", {
      type: "AWS::S3Vectors::VectorBucket",
      properties: {
        VectorBucketName: bucketName,
      },
    });

    this.index = new cdk.CfnResource(this, "Index", {
      type: "AWS::S3Vectors::Index",
      properties: {
        VectorBucketName: bucketName,
        IndexName: indexName,
        DataType: "float32",
        Dimension: 1024, // Titan Text Embeddings V2
        DistanceMetric: "cosine",
        MetadataConfiguration: {
          // department drives retrieval-time filtering; keep it filterable.
          NonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT"],
        },
      },
    });
    this.index.addDependency(this.vectorBucket);

    // Vector resources hold derived data (re-ingestable from S3 source
    // documents), but retain them in prd to avoid a full re-ingestion on
    // accidental stack replacement.
    const retain = props.envName === "prd";
    this.vectorBucket.applyRemovalPolicy(
      retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    );
    this.index.applyRemovalPolicy(
      retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    );

    this.indexArn = this.index.getAtt("IndexArn").toString();

    new cdk.CfnOutput(this, "VectorIndexArn", { value: this.indexArn });
  }
}
