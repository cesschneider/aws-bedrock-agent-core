import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";

export interface CatalogApiProps {
  envName: string;
  /** The catalog-handler Lambda that serves department/tag management. */
  catalogHandler: lambdaNode.NodejsFunction;
  /** Cognito user pool whose JWTs authorize catalog requests. */
  userPool: cognito.UserPool;
  /** App client accepted as JWT audience. */
  userPoolClient: cognito.UserPoolClient;
}

/**
 * HTTP API fronting the catalog-handler. Exposes per-tenant department and
 * tag management behind the same Cognito JWT authorizer as the upload and
 * documents APIs.
 */
export class CatalogApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: CatalogApiProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const authorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      `https://cognito-idp.${stack.region}.amazonaws.com/${props.userPool.userPoolId}`,
      {
        jwtAudience: [props.userPoolClient.userPoolClientId],
      }
    );

    this.httpApi = new apigwv2.HttpApi(this, "CatalogApi", {
      apiName: `rag-knowledge-agent-catalog-${props.envName}`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["content-type", "authorization"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const integration = new integrations.HttpLambdaIntegration(
      "CatalogHandlerIntegration",
      props.catalogHandler
    );

    this.httpApi.addRoutes({
      path: "/catalog/departments",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/catalog/departments/{name}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/catalog/tags",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/catalog/tags/{name}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
      authorizer,
    });

    new cdk.CfnOutput(this, "CatalogApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
