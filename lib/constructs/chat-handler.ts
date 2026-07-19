import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as path from "path";

function retentionFor(envName: string): logs.RetentionDays {
  return envName === "prd" ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS;
}

export interface ChatHandlerProps {
  envName: string;
  /** DynamoDB table for per-user conversation history persistence. */
  conversationTable: dynamodb.Table;
  /** S3 bucket for presigned citation download URLs. */
  documentsBucket: s3.Bucket;
  /** Cognito user pool ID for JWT validation (issuer field). */
  cognitoUserPoolId: string;
  /** Cognito client ID for JWT audience validation. */
  cognitoClientId: string;
  /** Bedrock agent ID; placeholder until the RagAgent construct is active. */
  agentId?: string;
  /** Bedrock agent alias ID; placeholder until the RagAgent construct is active. */
  agentAliasId?: string;
}

/**
 * Lambda Function URL chat-handler (spec Section 4.4).
 *
 * Entry point for the RAG Q&A flow: validates the user's Cognito JWT,
 * extracts department claims, invokes the Bedrock Agent with a department-
 * scoped metadata filter, streams the grounded answer with citations back,
 * and persists each turn to DynamoDB.
 *
 * RESPONSE_STREAM invoke mode enables token-by-token streaming — the
 * frontend sees words appear as they're generated.
 */
export class ChatHandler extends Construct {
  public readonly fn: lambdaNode.NodejsFunction;
  public readonly fnUrl: lambda.FunctionUrl;

  constructor(scope: Construct, id: string, props: ChatHandlerProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "ChatHandlerLogGroup", {
      retention: retentionFor(props.envName),
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.fn = new lambdaNode.NodejsFunction(this, "ChatHandlerFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../../lambda/chat-handler/index.ts"),
      handler: "handler",
      environment: {
        CONVERSATION_TABLE_NAME: props.conversationTable.tableName,
        DOCUMENTS_BUCKET_NAME: props.documentsBucket.bucketName,
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        AGENT_ID: props.agentId ?? "PENDING-AGENT-ID",
        AGENT_ALIAS_ID: props.agentAliasId ?? "PENDING-AGENT-ALIAS-ID",
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup,
    });

    // Invoke the Bedrock Agent at runtime.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeAgent"],
        resources: ["*"], // scoped to specific agent/alias once they exist
      })
    );

    // Write conversation turns to DynamoDB.
    props.conversationTable.grantWriteData(this.fn);

    // Generate presigned S3 URLs for citation downloads.
    props.documentsBucket.grantRead(this.fn);

    // Lambda Function URL with streaming response — no API Gateway needed
    // (spec 4.4). Auth is handled in application code (JWT validation), not
    // at the gateway layer (AWS_NONE).
    this.fnUrl = this.fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ["*"], // tighten once frontend URL is known
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["content-type", "authorization"],
      },
    });
  }
}
