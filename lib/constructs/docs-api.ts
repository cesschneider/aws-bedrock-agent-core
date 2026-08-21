import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";

function retentionFor(envName: string): logs.RetentionDays {
  return envName === "prd" ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS;
}

/**
 * Public (no-auth) API documentation endpoint.
 *
 * Serves the full API spec as JSON (and an HTML view) at GET /docs. This is
 * public documentation, not data, so it is intentionally unauthenticated.
 */
export class DocsApi extends Construct {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: { envName: string }) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "DocsHandlerLogGroup", {
      retention: retentionFor(props.envName),
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambdaNode.NodejsFunction(this, "DocsHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../../lambda/docs-handler/index.ts"),
      handler: "handler",
      timeout: cdk.Duration.seconds(5),
      logGroup,
    });

    this.httpApi = new apigwv2.HttpApi(this, "DocsApi", {
      apiName: `rag-knowledge-agent-docs-${props.envName}`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ["*"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    this.httpApi.addRoutes({
      path: "/docs",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration("DocsIntegration", fn),
    });

    new cdk.CfnOutput(this, "DocsApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
