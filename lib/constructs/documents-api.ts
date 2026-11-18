import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export interface DocumentsApiProps {
  envName: string;
  /** The documents-handler Lambda that serves list/get/delete. */
  documentsHandler: lambdaNode.NodejsFunction;
  /** Dual-issuer (Cognito + Supabase) Lambda authorizer. */
  authorizer: apigwv2.IHttpRouteAuthorizer;
  /** Raw-documents bucket the handler deletes objects from. */
  documentsBucket: s3.Bucket;
  /** Document registry table the handler reads/writes. */
  registryTable: dynamodb.Table;
}

/**
 * HTTP API fronting the documents-handler (multi-tenant design §4.2
 * extension). Exposes GET /documents, GET /documents/{id}, and
 * DELETE /documents/{id}, all behind the shared dual-issuer Lambda authorizer.
 */
export class DocumentsApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: DocumentsApiProps) {
    super(scope, id);

    this.httpApi = new apigwv2.HttpApi(this, "DocumentsApi", {
      apiName: `rag-knowledge-agent-documents-${props.envName}`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["content-type", "authorization"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const integration = new integrations.HttpLambdaIntegration(
      "DocumentsHandlerIntegration",
      props.documentsHandler
    );

    this.httpApi.addRoutes({
      path: "/documents",
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer: props.authorizer,
    });

    this.httpApi.addRoutes({
      path: "/documents/{id}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: props.authorizer,
    });

    new cdk.CfnOutput(this, "DocumentsApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
