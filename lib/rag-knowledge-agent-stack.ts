import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { UploadPipeline } from "./constructs/upload-pipeline";
import { KbSync } from "./constructs/kb-sync";
import { ConversationHistory } from "./constructs/conversation-history";
import { Identity } from "./constructs/identity";
import { ChatHandler } from "./constructs/chat-handler";
import { KnowledgeBase } from "./constructs/knowledge-base";
import { RagAgent } from "./constructs/agent";
import { UploadApi } from "./constructs/upload-api";
import { VectorIndex } from "./constructs/vector-index";
import { TenantRegistry } from "./constructs/tenant-registry";
import { TenantProvisioningApi } from "./constructs/tenant-provisioning-api";

export interface RagKnowledgeAgentStackProps extends cdk.StackProps {
  /** Deployment environment slug: dev | stg | prd */
  envName: string;
  /**
   * Optional pre-resolved Google OAuth client secret. If omitted, the stack
   * resolves it at synthesis time via ssm.StringParameter.valueFromLookup.
   * Useful in tests where SSM context resolution isn't available.
   */
  googleClientSecretOverride?: string;
  /**
   * Optional temporary password for the native dev test user (non-prd only).
   * Passed via CDK context from a GitHub Environment secret at deploy time
   * (see bin/app.ts and .github/workflows/deploy.yml). When absent/undefined,
   * no dev test user is created (deploy still succeeds).
   */
  devTestUserPassword?: string;
}

/**
 * Root stack for the internal RAG knowledge agent.
 *
 * Constructs are added story-by-story (see TODOS.md / spec Suggested Phases):
 * S3 + upload-handler, kb-sync-trigger, Bedrock Knowledge Base, chat-handler,
 * Cognito federation, DynamoDB conversation history, observability.
 */
export class RagKnowledgeAgentStack extends cdk.Stack {
  public readonly envName: string;
  public readonly uploadPipeline: UploadPipeline;
  public readonly kbSync: KbSync;
  public readonly conversationHistory: ConversationHistory;
  public readonly identity: Identity;
  public readonly chatHandler: ChatHandler;
  public readonly knowledgeBase: KnowledgeBase;
  public readonly ragAgent: RagAgent;
  public readonly uploadApi: UploadApi;
  public readonly vectorIndex: VectorIndex;
  public readonly tenantRegistry: TenantRegistry;
  public readonly tenantProvisioningApi: TenantProvisioningApi;

  constructor(scope: Construct, id: string, props: RagKnowledgeAgentStackProps) {
    super(scope, id, props);
    this.envName = props.envName;

    cdk.Tags.of(this).add("project", "rag-knowledge-agent");
    cdk.Tags.of(this).add("environment", this.envName);

    this.uploadPipeline = new UploadPipeline(this, "UploadPipeline", {
      envName: this.envName,
    });

    // S3 Vectors bucket + index are IaC-managed like everything else
    // (AWS::S3Vectors::* CloudFormation resources — no CLI-created
    // resources in this project, ever).
    this.vectorIndex = new VectorIndex(this, "VectorIndex", {
      envName: this.envName,
    });

    this.knowledgeBase = new KnowledgeBase(this, "KnowledgeBase", {
      envName: this.envName,
      sourceBucket: this.uploadPipeline.bucket,
      vectorIndexArn: this.vectorIndex.indexArn,
    });
    this.knowledgeBase.node.addDependency(this.vectorIndex);

    this.ragAgent = new RagAgent(this, "RagAgent", {
      envName: this.envName,
      knowledgeBaseId: this.knowledgeBase.knowledgeBase.attrKnowledgeBaseId,
      knowledgeBaseArn: this.knowledgeBase.knowledgeBase.attrKnowledgeBaseArn,
    });

    this.kbSync = new KbSync(this, "KbSync", {
      envName: this.envName,
      sourceBucket: this.uploadPipeline.bucket,
      knowledgeBaseId: this.knowledgeBase.knowledgeBase.attrKnowledgeBaseId,
      dataSourceId: this.knowledgeBase.dataSource.attrDataSourceId,
    });

    this.conversationHistory = new ConversationHistory(this, "ConversationHistory", {
      envName: this.envName,
    });

    this.tenantRegistry = new TenantRegistry(this, "TenantRegistry", {
      envName: this.envName,
    });

    // Self-service provisioning (STORY-B2): public HTTP API for sign-up and
    // admin-email confirmation, writing to the tenant registry.
    this.tenantProvisioningApi = new TenantProvisioningApi(this, "TenantProvisioningApi", {
      envName: this.envName,
      tenantRegistryTable: this.tenantRegistry.table,
    });

    // Google OAuth client ID/secret and the Workspace admin service account
    // key are created manually (Google Cloud Console / Workspace Admin
    // console — see docs/deployment-setup.md) and stored in SSM per
    // environment. The client secret is resolved at synthesis time
    // (valueFromLookup) because Cognito's UserPoolIdentityProvider rejects
    // CloudFormation dynamic references ({{resolve:ssm-secure:...}}).
    const googleClientSecret = props.googleClientSecretOverride ??
      ssm.StringParameter.valueFromLookup(
        this,
        `/rag-knowledge-agent/${this.envName}/google-client-secret`
      );

    // Dev test user password (non-prd only) comes from a CDK context value
    // (GitHub Environment secret) — not an SSM lookup — so a missing secret
    // skips the dev user instead of failing synthesis.
    this.identity = new Identity(this, "Identity", {
      envName: this.envName,
      googleClientId: "PENDING-GOOGLE-OAUTH-CLIENT-ID",
      googleClientSecret,
      googleServiceAccountKeyParam: `/rag-knowledge-agent/${this.envName}/google-service-account-key`,
      googleWorkspaceAdminEmail: `admin@${this.envName}.pending-setup.invalid`,
      tenantRegistryTable: this.tenantRegistry.table,
      devTestUserPassword: props.devTestUserPassword,
    });

    this.chatHandler = new ChatHandler(this, "ChatHandler", {
      envName: this.envName,
      conversationTable: this.conversationHistory.table,
      documentsBucket: this.uploadPipeline.bucket,
      cognitoUserPoolId: this.identity.userPool.userPoolId,
      cognitoClientId: this.identity.userPoolClient.userPoolClientId,
      agentId: this.ragAgent.agent.attrAgentId,
      agentAliasId: this.ragAgent.agentAlias.attrAgentAliasId,
      knowledgeBaseId: this.knowledgeBase.knowledgeBase.attrKnowledgeBaseId,
    });

    this.uploadApi = new UploadApi(this, "UploadApi", {
      envName: this.envName,
      uploadHandler: this.uploadPipeline.uploadHandler,
      userPool: this.identity.userPool,
      userPoolClient: this.identity.userPoolClient,
    });

    // Surface the values the chat CLI and the upload guide need, so they can
    // be discovered from `aws cloudformation describe-stacks` without hunting
    // through resources.
    new cdk.CfnOutput(this, "ChatHandlerFunctionUrl", {
      value: this.chatHandler.fnUrl.url,
      description: "Lambda Function URL for the chat endpoint (POST, JWT bearer auth).",
    });
    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: this.identity.userPool.userPoolId,
    });
    new cdk.CfnOutput(this, "CognitoClientId", {
      value: this.identity.userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "RawDocumentsBucket", {
      value: this.uploadPipeline.bucket.bucketName,
      description: "S3 bucket for source documents; uploading triggers KB ingestion.",
    });
  }
}

