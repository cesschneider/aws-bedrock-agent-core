import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";

export interface UploadApiProps {
  envName: string;
  /** The upload-handler Lambda that signs presigned POSTs. */
  uploadHandler: lambdaNode.NodejsFunction;
  /** Dual-issuer (Cognito + Supabase) Lambda authorizer. */
  authorizer: apigwv2.IHttpRouteAuthorizer;
}

/**
 * HTTP API fronting the upload-handler (spec Section 4.2).
 *
 * Uses the shared dual-issuer Lambda authorizer (Cognito RS256 + Supabase
 * ES256), so the Lovable UI can call it with either token type. The Lambda
 * only ever sees requests with a validated token and reads the normalized
 * context from `requestContext.authorizer.lambda.*`.
 */
export class UploadApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: UploadApiProps) {
    super(scope, id);

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
      authorizer: props.authorizer,
    });

    new cdk.CfnOutput(this, "UploadApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
