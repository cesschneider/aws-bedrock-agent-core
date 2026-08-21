import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as path from "path";

function retentionFor(envName: string): logs.RetentionDays {
  return envName === "prd" ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS;
}

export interface TenantProvisioningApiProps {
  envName: string;
  /** Tenant registry table the provisioning Lambda writes to. */
  tenantRegistryTable: dynamodb.Table;
  /** Tenant membership table — the provisioning admin's membership is created here on activation. */
  tenantMembershipTable?: dynamodb.Table;
  /**
   * Optional verified SES sender email. When set, the Lambda emails the
   * verification link via SES and is granted ses:SendEmail. When omitted
   * (dev), the Lambda logs the link instead — the flow still works.
   */
  fromEmail?: string;
}

/**
 * Self-service tenant provisioning API (multi-tenant design Phase B2).
 *
 * Exposes POST /signup and POST /confirm on a public HTTP API (no auth — the
 * sign-up flow is anonymous by design). The Lambda writes PENDING tenants to
 * the registry and activates them on admin-email confirmation.
 */
export class TenantProvisioningApi extends Construct {
  public readonly fn: lambdaNode.NodejsFunction;
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: TenantProvisioningApiProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "TenantProvisioningLogGroup", {
      retention: retentionFor(props.envName),
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.fn = new lambdaNode.NodejsFunction(this, "TenantProvisioningFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../../lambda/tenant-provisioning/index.ts"),
      handler: "handler",
      environment: {
        TENANT_REGISTRY_TABLE_NAME: props.tenantRegistryTable.tableName,
        TENANT_MEMBERSHIP_TABLE_NAME: props.tenantMembershipTable?.tableName ?? "",
        ...(props.fromEmail ? { FROM_EMAIL: props.fromEmail } : {}),
      },
      timeout: cdk.Duration.seconds(10),
      logGroup,
    });

    // Write access to the tenant registry (create PENDING, activate).
    props.tenantRegistryTable.grantReadWriteData(this.fn);
    // Write access to the membership table (create the admin membership).
    props.tenantMembershipTable?.grantWriteData(this.fn);

    // SES send permission only when a sender is configured.
    if (props.fromEmail) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: ["*"], // SES identity ARN is account/region-specific; scoped at identity level
        })
      );
    }

    this.httpApi = new apigwv2.HttpApi(this, "TenantProvisioningApi", {
      apiName: `rag-knowledge-agent-provisioning-${props.envName}`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    this.httpApi.addRoutes({
      path: "/signup",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "SignupIntegration",
        this.fn
      ),
    });

    this.httpApi.addRoutes({
      path: "/confirm",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "ConfirmIntegration",
        this.fn
      ),
    });

    new cdk.CfnOutput(this, "TenantProvisioningApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
