import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as path from "path";

export interface DualIssuerAuthorizerProps {
  envName: string;
  /** Cognito user pool ID (issuer for the Cognito path). */
  cognitoUserPoolId: string;
  /** Cognito app client ID (audience for the Cognito path). */
  cognitoClientId: string;
  /** Supabase project ref (Lovable Cloud) — enables the Supabase path. */
  supabaseProjectRef?: string;
  /** Tenant membership table — resolves tenant by email for Supabase tokens. */
  tenantMembershipTable?: dynamodb.Table;
}

/**
 * A reusable API Gateway Lambda authorizer that validates either a Cognito
 * (RS256) or Supabase/Lovable Cloud (ES256) bearer token and returns a
 * normalized context (`tenantId`, `email`, `departments`, `userId`).
 *
 * Replaces the per-API Cognito `HttpJwtAuthorizer` so the Lovable UI can call
 * every endpoint with its Supabase access token. The validation logic is the
 * shared `TokenVerifier` (also used by the chat-handler).
 */
export class DualIssuerAuthorizer extends Construct {
  public readonly fn: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: DualIssuerAuthorizerProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "AuthorizerLogGroup", {
      retention: props.envName === "prd" ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.fn = new lambdaNode.NodejsFunction(this, "AuthorizerFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../../lambda/authorizer/index.ts"),
      handler: "handler",
      environment: {
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_CLIENT_ID: props.cognitoClientId,
        SUPABASE_PROJECT_REF: props.supabaseProjectRef ?? "",
        TENANT_MEMBERSHIP_TABLE_NAME: props.tenantMembershipTable?.tableName ?? "",
      },
      timeout: cdk.Duration.seconds(10),
      logGroup,
    });

    // Read membership to resolve tenant by email (Supabase token path).
    props.tenantMembershipTable?.grantReadData(this.fn);
  }

  /**
   * Returns a NEW `HttpLambdaAuthorizer` bound to the shared authorizer
   * Lambda. API Gateway forbids attaching the same authorizer object to
   * multiple HTTP APIs, so each API gets its own authorizer instance that
   * points at the same Lambda (one validation implementation, many bindings).
   */
  authorizerFor(scope: Construct, id: string): authorizers.HttpLambdaAuthorizer {
    return new authorizers.HttpLambdaAuthorizer(id, this.fn, {
      authorizerName: `rag-knowledge-agent-dual-issuer-${scope.node.path.replace(/[^a-zA-Z0-9]/g, "-")}`,
      responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
      // Cache disabled: the authorizer resolves tenant from membership and
      // must not serve a stale context across token/tenant changes. JWKS are
      // cached inside the Lambda (1 min TTL) so this stays cheap.
      resultsCacheTtl: cdk.Duration.seconds(0),
    });
  }
}
