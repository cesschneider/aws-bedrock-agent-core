import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as bedrock from "aws-cdk-lib/aws-bedrock";

export interface KnowledgeBaseProps {
  envName: string;
  /** Bucket holding the raw documents Bedrock KB ingests from. */
  sourceBucket: s3.Bucket;
  /**
   * ARN of the S3 Vectors index used as the vector store backend.
   * Created by the S3 Vectors setup (Phase 0 spike outcome) — S3 Vectors
   * has no CloudFormation/CDK L2 support yet, so the index is provisioned
   * via the vectors bucket resource and referenced here.
   */
  vectorIndexArn: string;
}

/**
 * Bedrock Knowledge Base over S3 Vectors (spec Section 4.3, Phase 1).
 *
 * Embeddings: Titan Text Embeddings V2 (1024-dim, spec Section 5a).
 * Vector store: Amazon S3 Vectors (validated by the Phase 0 spike; the
 * fallback if it proves immature is OpenSearch Serverless — swapping the
 * storageConfiguration here is the single change point for that).
 *
 * Chunking uses semantic chunking (spec 5a) configured on the data source.
 * Department scoping happens at retrieval time via metadata filters — the
 * `department` metadata attribute is attached by the kb-sync sidecar files
 * during ingestion (spec Section 4.3).
 */
export class KnowledgeBase extends Construct {
  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  public readonly dataSource: bedrock.CfnDataSource;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const embeddingModelArn = `arn:aws:bedrock:${stack.region}::foundation-model/amazon.titan-embed-text-v2:0`;

    // Service role Bedrock assumes to read source documents and write vectors.
    this.role = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
          ArnLike: {
            "aws:SourceArn": stack.formatArn({
              service: "bedrock",
              resource: "knowledge-base",
              resourceName: "*",
            }),
          },
        },
      }),
    });
    props.sourceBucket.grantRead(this.role);
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [embeddingModelArn],
      })
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:GetIndex",
          "s3vectors:QueryVectors",
          "s3vectors:PutVectors",
          "s3vectors:GetVectors",
          "s3vectors:DeleteVectors",
        ],
        resources: [props.vectorIndexArn],
      })
    );

    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `rag-knowledge-agent-${props.envName}`,
      roleArn: this.role.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
        },
      },
      storageConfiguration: {
        // S3 Vectors backend (spec 5a). Swap this block for
        // opensearchServerlessConfiguration if the Phase 0 spike falls back.
        type: "S3_VECTORS",
        s3VectorsConfiguration: {
          indexArn: props.vectorIndexArn,
        },
      } as unknown as bedrock.CfnKnowledgeBase.StorageConfigurationProperty,
    });
    this.knowledgeBase.node.addDependency(this.role);

    this.dataSource = new bedrock.CfnDataSource(this, "RawDocumentsSource", {
      name: `raw-documents-${props.envName}`,
      knowledgeBaseId: this.knowledgeBase.attrKnowledgeBaseId,
      // Documents remain in S3 when the data source is deleted — deleting
      // KB infrastructure must never destroy uploaded company documents.
      dataDeletionPolicy: "RETAIN",
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: props.sourceBucket.bucketArn,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "SEMANTIC",
          semanticChunkingConfiguration: {
            maxTokens: 300,
            bufferSize: 1,
            breakpointPercentileThreshold: 95,
          },
        },
      },
    });

    new cdk.CfnOutput(this, "KnowledgeBaseId", {
      value: this.knowledgeBase.attrKnowledgeBaseId,
    });
    new cdk.CfnOutput(this, "DataSourceId", {
      value: this.dataSource.attrDataSourceId,
    });
  }
}

