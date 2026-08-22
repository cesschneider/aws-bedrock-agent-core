import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";

export interface OrganizationsApiProps {
  envName: string;
  /** The organizations-handler Lambda that serves name check + creation. */
  organizationsHandler: lambdaNode.NodejsFunction;
  /** Dual-issuer (Cognito + Supabase) Lambda authorizer. */
  authorizer: apigwv2.IHttpRouteAuthorizer;
}

/**
 * HTTP API fronting the organizations-handler. Exposes name availability
 * check and organization creation behind the shared dual-issuer Lambda
 * authorizer (the caller is an authenticated Google user).
 */
export class OrganizationsApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: OrganizationsApiProps) {
    super(scope, id);

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
      authorizer: props.authorizer,
    });

    this.httpApi.addRoutes({
      path: "/organizations",
      methods: [apigwv2.HttpMethod.POST],
      integration,
      authorizer: props.authorizer,
    });

    new cdk.CfnOutput(this, "OrganizationsApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
