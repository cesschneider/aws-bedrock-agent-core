import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as cognito from "aws-cdk-lib/aws-cognito";

export interface MembersApiProps {
  envName: string;
  /** The members-handler Lambda that serves member management. */
  membersHandler: lambdaNode.NodejsFunction;
  /** Cognito user pool whose JWTs authorize member requests. */
  userPool: cognito.UserPool;
  /** App client accepted as JWT audience. */
  userPoolClient: cognito.UserPoolClient;
}

/**
 * HTTP API fronting the members-handler. Exposes per-tenant member management
 * (invite/list/accept/remove) behind the same Cognito JWT authorizer as the
 * upload, documents, and catalog APIs.
 */
export class MembersApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: MembersApiProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    const authorizer = new authorizers.HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      `https://cognito-idp.${stack.region}.amazonaws.com/${props.userPool.userPoolId}`,
      {
        jwtAudience: [props.userPoolClient.userPoolClientId],
      }
    );

    this.httpApi = new apigwv2.HttpApi(this, "MembersApi", {
      apiName: `rag-knowledge-agent-members-${props.envName}`,
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
      "MembersHandlerIntegration",
      props.membersHandler
    );

    this.httpApi.addRoutes({
      path: "/members",
      methods: [apigwv2.HttpMethod.GET],
      integration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/members/invite",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/members/accept",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer,
    });

    this.httpApi.addRoutes({
      path: "/members/{email}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
      authorizer,
    });

    new cdk.CfnOutput(this, "MembersApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
