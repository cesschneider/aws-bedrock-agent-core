import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";

export interface IdentityProps {
  envName: string;
  /**
   * SSM parameter name (SecureString) holding the Google OAuth client
   * secret. Populated manually via the Google Cloud Console OAuth
   * credentials page — see docs/deployment-setup.md.
   */
  googleClientSecretParam: string;
  /** Google OAuth client ID (not secret, safe as a plain prop). */
  googleClientId: string;
  /** SSM parameter name (SecureString) holding the Workspace service account key JSON. */
  googleServiceAccountKeyParam: string;
  /** Email of a Google Workspace super admin the service account impersonates. */
  googleWorkspaceAdminEmail: string;
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

    const googleClientSecret = cdk.SecretValue.ssmSecure(props.googleClientSecretParam);

    const googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, "GoogleIdentityProvider", {
      userPool: this.userPool,
      clientId: props.googleClientId,
      clientSecretValue: googleClientSecret,
      scopes: ["email", "profile", "openid"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
      },
    });

    this.userPoolClient = this.userPool.addClient("WebClient", {
      generateSecret: false, // public client (web SPA) — no client secret to leak
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
    });
    this.userPoolClient.node.addDependency(googleIdp);
  }
}
