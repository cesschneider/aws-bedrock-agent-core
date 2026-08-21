import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";

export interface OrganizationsApiProps {
  envName: string;
  /** The organizations-handler Lambda that serves name check + creation. */
  organizationsHandler: lambdaNode.NodejsFunction;
  /** Cognito user pool whose JWTs authorize organization requests. */
  userPool: cognito.UserPool;
  /** App client accepted as JWT audience. */
  userPoolClient: cognito.UserPoolClient;
}

/**
 * HTTP API fronting the organizations-handler. Exposes name availability
 * check and organization creation behind the Cognito JWT authorizer (the
 * caller is an authenticated Google user).
 */
export class OrganizationsApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: OrganizationsApiProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const authorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      `https://cognito-idp.${stack.region}.amazonaws.com/${props.userPool.userPoolId}`,
      {
        jwtAudience: [props.userPoolClient.userPoolClientId],
      }
    );

    this.httpApi = new apigwv2.HttpApi(this, "OrganizationsApi", {
      apiName: `rag-knowledge-agent-organizations-${props.envName}`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["content-type", "authorization"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const integration = new integrations.HttpLambdaIntegration(
      "OrganizationsHandlerIntegration",
      props.organizationsHandler
    );

    this.httpApi.addRoutes({
      path: "/organizations/check-name",
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/organizations",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer,
    });

    new cdk.CfnOutput(this, "OrganizationsApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
