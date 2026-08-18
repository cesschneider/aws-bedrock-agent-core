import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as path from "path";

export interface IdentityProps {
  envName: string;
  /**
   * Google OAuth client secret. Must be resolved BEFORE passing to this
   * construct (e.g. via ssm.StringParameter.valueFromLookup in the parent
   * stack) because Cognito's UserPoolIdentityProvider rejects CloudFormation
   * dynamic references ({{resolve:ssm-secure:...}}) in client_secret.
   */
  googleClientSecret: string;
  /** Google OAuth client ID (not secret, safe as a plain prop). */
  googleClientId: string;
  /** SSM parameter name (SecureString) holding the Workspace service account key JSON. */
  googleServiceAccountKeyParam: string;
  /** Email of a Google Workspace super admin the service account impersonates. */
  googleWorkspaceAdminEmail: string;
  /** Tenant registry table — enables registry-backed tenant resolution. */
  tenantRegistryTable?: dynamodb.Table;
  /**
   * Optional temporary password for a native (non-Google) dev test user,
   * resolved at synthesis time via ssm.StringParameter.valueFromLookup
   * (SecureString — see docs/deployment-setup.md). When provided in a non-prd
   * environment, a Cognito user `dev-tester@example.invalid` is created in the
   * `dept-engineering` group so the chat CLI can log in via USER_PASSWORD_AUTH
   * without Google Workspace federation. Never created in prd. The pre-token
   * generation trigger's native-user branch passes the Cognito group through
   * as the department claim.
   */
  devTestUserPassword?: string;
}

function retentionFor(envName: string): logs.RetentionDays {
  return envName === "prd" ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS;
}

/**
 * Cognito User Pool federated with Google Workspace (spec Section 4.1).
 *
 * Department membership is NOT modeled as native Cognito Groups — it's
 * computed per-token by the pre-token-generation Lambda, which calls the
 * Google Admin SDK to fetch the authenticating user's current Workspace
 * group memberships and overrides the token's cognito:groups claim
 * directly (Cognito's PreTokenGeneration V2 groupOverrideDetails
 * mechanism). This means group membership is always fresh at login time —
 * no need to keep Cognito's own group objects in sync with Workspace.
 */
export class Identity extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: IdentityProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "PreTokenGenerationLogGroup", {
      retention: retentionFor(props.envName),
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const preTokenGeneration = new lambdaNode.NodejsFunction(this, "PreTokenGeneration", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../../lambda/pre-token-generation/index.ts"),
      handler: "handler",
      environment: {
        GOOGLE_SERVICE_ACCOUNT_KEY_PARAM: props.googleServiceAccountKeyParam,
        GOOGLE_WORKSPACE_ADMIN_EMAIL: props.googleWorkspaceAdminEmail,
        TENANT_REGISTRY_TABLE_NAME: props.tenantRegistryTable?.tableName ?? "",
      },
      timeout: cdk.Duration.seconds(10),
      logGroup,
    });

    preTokenGeneration.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: props.googleServiceAccountKeyParam.replace(/^\//, ""),
          }),
        ],
      })
    );

    // Read access to the tenant registry for domain → tenant resolution.
    props.tenantRegistryTable?.grantReadData(preTokenGeneration);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `rag-knowledge-agent-${props.envName}`,
      selfSignUpEnabled: false, // identity is federated from Google Workspace only
      signInAliases: { email: true },
      removalPolicy: props.envName === "prd" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // V2_0 is required (not V1_0) so the trigger can use groupOverrideDetails
    // to set the token's cognito:groups claim directly from Google Workspace
    // group membership, rather than relying on native Cognito Group objects.
    this.userPool.addTrigger(
      cognito.UserPoolOperation.PRE_TOKEN_GENERATION_CONFIG,
      preTokenGeneration,
      cognito.LambdaVersion.V2_0
    );

    // Resolved upstream via ssm.StringParameter.valueFromLookup — Cognito
    // does not support CFN dynamic references in client_secret.
    const googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, "GoogleIdentityProvider", {
      userPool: this.userPool,
      clientId: props.googleClientId,
      clientSecretValue: cdk.SecretValue.unsafePlainText(props.googleClientSecret),
      scopes: ["email", "profile", "openid"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
      },
    });

    this.userPoolClient = this.userPool.addClient("WebClient", {
      generateSecret: false, // public client (web SPA) — no client secret to leak
      // USER_PASSWORD_AUTH lets the dev CLI log in as a native Cognito user
      // (dev-tester) without going through Google Workspace federation. The
      // authorizationCodeGrant flow remains for the production Google path.
      authFlows: { userPassword: true, custom: false, userSrp: false, adminUserPassword: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.GOOGLE,
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });
    this.userPoolClient.node.addDependency(googleIdp);

    // Dev test user (non-prd only) — lets the chat CLI exercise the agent
    // without Google Workspace federation. Department scoping comes from the
    // native Cognito group, which the pre-token generation trigger passes
    // through for non-Google users. The password is supplied via a CDK context
    // value (GitHub Environment secret) — see bin/app.ts.
    //
    // The user is created via a raw CfnResource (this CDK version's
    // CfnUserPoolUser L1 doesn't model every property, and there is no Group
    // L2) — same escape hatch used for S3 Vectors in lib/constructs/vector-index.ts.
    // The password is NOT set on the CloudFormation resource: AWS removed
    // `TemporaryPassword` from AWS::Cognito::UserPoolUser (it leaked the
    // password in the template), so CloudFormation's early validation rejects
    // it. Instead the permanent password is set via an AdminSetUserPassword SDK
    // call made by an AwsCustomResource during deploy — IaC-only, no CLI step.
    if (props.envName !== "prd" && props.devTestUserPassword) {
      const devDepartment = "dept-engineering";
      const devUsername = "dev-tester@example.invalid";

      const devGroup = new cognito.CfnUserPoolGroup(this, "DevTestGroup", {
        userPoolId: this.userPool.userPoolId,
        groupName: devDepartment,
        description: "Native Cognito group for the dev test user (dept stand-in)",
      });

      const devUser = new cdk.CfnResource(this, "DevTestUser", {
        type: "AWS::Cognito::UserPoolUser",
        properties: {
          UserPoolId: this.userPool.userPoolId,
          Username: devUsername,
          MessageAction: "SUPPRESS", // no welcome email for the dev test user
          DesiredDeliveryMediums: [],
          UserAttributes: [
            { Name: "email", Value: devUsername },
            { Name: "email_verified", Value: "true" },
          ],
        },
      });
      devUser.node.addDependency(devGroup);

      new cognito.CfnUserPoolUserToGroupAttachment(this, "DevTestUserGroupAttachment", {
        userPoolId: this.userPool.userPoolId,
        username: devUsername,
        groupName: devDepartment,
      }).node.addDependency(devUser, devGroup);

      // Set the dev test user's permanent password via an SDK call (see comment
      // above). Runs on create and whenever the password context value changes.
      const setPassword = new cr.AwsCustomResource(this, "DevTestUserPassword", {
        onCreate: {
          service: "CognitoIdentityServiceProvider",
          action: "adminSetUserPassword",
          parameters: {
            UserPoolId: this.userPool.userPoolId,
            Username: devUsername,
            Password: props.devTestUserPassword,
            Permanent: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `DevTestUserPassword-${this.userPool.userPoolId}-${devUsername}`
          ),
        },
        onUpdate: {
          service: "CognitoIdentityServiceProvider",
          action: "adminSetUserPassword",
          parameters: {
            UserPoolId: this.userPool.userPoolId,
            Username: devUsername,
            Password: props.devTestUserPassword,
            Permanent: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `DevTestUserPassword-${this.userPool.userPoolId}-${devUsername}`
          ),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["cognito-idp:AdminSetUserPassword"],
            resources: [this.userPool.userPoolArn],
          }),
        ]),
      });
      setPassword.node.addDependency(devUser);
    }
  }
}

