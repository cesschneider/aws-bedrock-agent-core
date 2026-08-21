import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as path from "path";

function retentionFor(envName: string): logs.RetentionDays {
  return envName === "prd" ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS;
}

export interface UploadPipelineProps {
  envName: string;
  /** Document registry table the upload-handler writes PENDING records to. */
  registryTable: dynamodb.Table;
}

/**
 * S3 raw-documents bucket + upload-handler Lambda (spec Section 4.2).
 *
 * The HTTP API + Cognito JWT authorizer that fronts this Lambda are wired
 * up once the Cognito federation construct (separate story) exists — this
 * construct owns the bucket and the Lambda's presigned-POST logic only.
 */
export class UploadPipeline extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly uploadHandler: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: UploadPipelineProps) {
    super(scope, id);

    // S3 bucket names are globally unique across ALL AWS accounts, not just
    // this one — appending the account ID avoids a collision with another
    // AWS customer's bucket (matters more now that each environment is its
    // own account, but the risk exists regardless of account topology).
    this.bucket = new s3.Bucket(this, "RawDocumentsBucket", {
      bucketName: `raw-documents-${props.envName}-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy:
        props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.envName !== "prd",
    });

    // The browser POSTs the file directly to S3 via the presigned URL, so the
    // bucket must allow cross-origin POSTs from the frontend. Without this the
    // upload fails with a CORS error even though the API call succeeded.
    // Tighten allowedOrigins to the frontend origin once it is known.
    this.bucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.POST],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
      maxAge: 3000,
    });

    const logGroup = new logs.LogGroup(this, "UploadHandlerLogGroup", {
      retention: retentionFor(props.envName),
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.uploadHandler = new lambdaNode.NodejsFunction(this, "UploadHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../../lambda/upload-handler/index.ts"),
      handler: "handler",
      environment: {
        UPLOAD_BUCKET_NAME: this.bucket.bucketName,
        DOCUMENT_REGISTRY_TABLE_NAME: props.registryTable.tableName,
      },
      timeout: cdk.Duration.seconds(10),
      logGroup,
    });

    // s3:PutObject only — the Lambda signs presigned POSTs for uploads, it
    // never reads or deletes objects itself (least privilege).
    this.bucket.grantPut(this.uploadHandler);
    // Write access to the document registry (PENDING records at upload time).
    props.registryTable.grantWriteData(this.uploadHandler);
  }
}

