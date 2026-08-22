import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";

export interface MembersApiProps {
  envName: string;
  /** The members-handler Lambda that serves member management. */
  membersHandler: lambdaNode.NodejsFunction;
  /** Dual-issuer (Cognito + Supabase) Lambda authorizer. */
  authorizer: apigwv2.IHttpRouteAuthorizer;
}

/**
 * HTTP API fronting the members-handler. Exposes per-tenant member management
 * (invite/list/accept/remove) behind the shared dual-issuer Lambda authorizer.
 */
export class MembersApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: MembersApiProps) {
    super(scope, id);

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
      authorizer: props.authorizer,
    });

    this.httpApi.addRoutes({
      path: "/members/invite",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: props.authorizer,
    });

    this.httpApi.addRoutes({
      path: "/members/accept",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: props.authorizer,
    });

    this.httpApi.addRoutes({
      path: "/members/{email}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration,
      authorizer: props.authorizer,
    });

    new cdk.CfnOutput(this, "MembersApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
