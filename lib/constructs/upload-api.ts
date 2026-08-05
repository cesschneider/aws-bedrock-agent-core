import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";

export interface UploadApiProps {
  envName: string;
  /** The upload-handler Lambda that signs presigned POSTs. */
  uploadHandler: lambdaNode.NodejsFunction;
  /** Cognito user pool whose JWTs authorize upload requests. */
  userPool: cognito.UserPool;
  /** App client accepted as JWT audience. */
  userPoolClient: cognito.UserPoolClient;
}

/**
 * HTTP API fronting the upload-handler (spec Section 4.2).
 *
 * Uses API Gateway's built-in JWT authorizer against the Cognito user pool —
 * unlike the chat-handler's Function URL, the upload path gets gateway-level
 * auth, so the Lambda only ever sees requests with a validated JWT and can
 * trust the claims in the request context (parseDepartmentClaims).
 */
export class UploadApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: UploadApiProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const authorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      `https://cognito-idp.${stack.region}.amazonaws.com/${props.userPool.userPoolId}`,
      {
        jwtAudience: [props.userPoolClient.userPoolClientId],
      }
    );

    this.httpApi = new apigwv2.HttpApi(this, "UploadApi", {
      apiName: `rag-knowledge-agent-upload-${props.envName}`,
      corsPreflight: {
        // Tighten allowOrigins to the frontend URL once it exists.
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type", "authorization"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    this.httpApi.addRoutes({
      path: "/uploads",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "UploadHandlerIntegration",
        props.uploadHandler
      ),
      authorizer,
    });

    new cdk.CfnOutput(this, "UploadApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}

