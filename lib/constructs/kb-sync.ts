import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-destinations";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";

export interface KbSyncProps {
  envName: string;
  sourceBucket: s3.Bucket;
  /**
   * Bedrock Knowledge Base + data source IDs are supplied once that construct
   * exists (blocked on the Phase 0 S3 Vectors validation spike — see
   * TODOS.md / spec Section 7). Passing placeholders lets this construct
   * synth independently in the meantime; wiring the real IDs through is a
   * one-line change once task #5 lands.
   */
  knowledgeBaseId: string;
  dataSourceId: string;
}

function retentionFor(envName: string): logs.RetentionDays {
  return envName === "prd" ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS;
}

/**
 * S3 ObjectCreated -> kb-sync-trigger Lambda (spec Section 4.3).
 *
 * Dedupes on (object-key, etag) via DynamoDB conditional writes so S3's
 * at-least-once event delivery doesn't trigger duplicate ingestion jobs
 * (Eng review addition). Failures route to an SQS dead-letter queue via the
 * Lambda's async invocation failure destination.
 */
export class KbSync extends Construct {
  public readonly dedupTable: dynamodb.Table;
  public readonly dlq: sqs.Queue;
  public readonly trigger: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: KbSyncProps) {
    super(scope, id);

    this.dedupTable = new dynamodb.Table(this, "IngestionDedupeTable", {
      partitionKey: { name: "dedupeKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.dlq = new sqs.Queue(this, "IngestionDlq", {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const logGroup = new logs.LogGroup(this, "KbSyncTriggerLogGroup", {
      retention: retentionFor(props.envName),
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.trigger = new lambdaNode.NodejsFunction(this, "KbSyncTrigger", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../../lambda/kb-sync-trigger/index.ts"),
      handler: "handler",
      environment: {
        DEDUP_TABLE_NAME: this.dedupTable.tableName,
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        DATA_SOURCE_ID: props.dataSourceId,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup,
      onFailure: new lambdaEventSources.SqsDestination(this.dlq),
    });

    this.dedupTable.grantReadWriteData(this.trigger);
    // Sidecar write needs PutObject; ingestion doesn't need to read source
    // documents (Bedrock KB reads directly from S3 via its own service role).
    props.sourceBucket.grantPut(this.trigger);

    props.sourceBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.trigger)
    );

    // Scoped to knowledge-base resources in this account/region, not a
    // blanket "*" — tighten further to the specific KB ARN once task #5
    // (the real Bedrock KB construct) exists and can be passed in directly.
    this.trigger.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:StartIngestionJob"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "bedrock",
            resource: "knowledge-base",
            resourceName: "*",
          }),
        ],
      })
    );
  }
}

