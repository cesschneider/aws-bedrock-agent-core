import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "path";
import { UploadPipeline } from "./constructs/upload-pipeline";
import { KbSync } from "./constructs/kb-sync";
import { ConversationHistory } from "./constructs/conversation-history";
import { Identity } from "./constructs/identity";
import { ChatHandler } from "./constructs/chat-handler";
import { KnowledgeBase } from "./constructs/knowledge-base";
import { RagAgent } from "./constructs/agent";
import { UploadApi } from "./constructs/upload-api";
import { VectorIndex } from "./constructs/vector-index";
import { DocumentRegistry } from "./constructs/document-registry";
import { DocumentsApi } from "./constructs/documents-api";
import { DocsApi } from "./constructs/docs-api";
import { TenantCatalog } from "./constructs/tenant-catalog";
import { CatalogApi } from "./constructs/catalog-api";
import { TenantMembership } from "./constructs/tenant-membership";
import { MembersApi } from "./constructs/members-api";
import { Organization } from "./constructs/organization";
import { OrganizationsApi } from "./constructs/organizations-api";

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
  /** Supabase project ref (Lovable Cloud) — enables dual-issuer JWT validation. */
  supabaseProjectRef?: string;
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
  public readonly documentRegistry: DocumentRegistry;
  public readonly documentsApi: DocumentsApi;
  public readonly docsApi: DocsApi;
  public readonly tenantCatalog: TenantCatalog;
  public readonly catalogApi: CatalogApi;
  public readonly tenantMembership: TenantMembership;
  public readonly membersApi: MembersApi;
  public readonly organization: Organization;
  public readonly organizationsApi: OrganizationsApi;

  constructor(scope: Construct, id: string, props: RagKnowledgeAgentStackProps) {
    super(scope, id, props);
    this.envName = props.envName;

    cdk.Tags.of(this).add("project", "rag-knowledge-agent");
    cdk.Tags.of(this).add("environment", this.envName);

    // Document registry — source of truth for the list/get/delete API. Must
    // exist before the upload pipeline (which writes PENDING records) and the
    // kb-sync trigger (which updates them to INDEXED).
    this.documentRegistry = new DocumentRegistry(this, "DocumentRegistry", {
      envName: this.envName,
    });

    // Per-tenant catalog of administrable departments + normalized tags. The
    // upload pipeline validates tags against it (when seeded).
    this.tenantCatalog = new TenantCatalog(this, "TenantCatalog", {
      envName: this.envName,
    });

    this.uploadPipeline = new UploadPipeline(this, "UploadPipeline", {
      envName: this.envName,
      registryTable: this.documentRegistry.table,
      catalogTable: this.tenantCatalog.table,
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
      registryTable: this.documentRegistry.table,
    });

    this.conversationHistory = new ConversationHistory(this, "ConversationHistory", {
      envName: this.envName,
    });

    // Email → tenant membership registry (multi-user support). The first user
    // of a tenant (the org-creating admin) is created here at org creation;
    // the members API manages invitations and membership.
    this.tenantMembership = new TenantMembership(this, "TenantMembership", {
      envName: this.envName,
    });

    // Organization registry (name-based org creation). Replaces the
    // domain→tenant registry: no domain action, no email-verification token.
    this.organization = new Organization(this, "Organization", {
      envName: this.envName,
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
      tenantMembershipTable: this.tenantMembership.table,
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
      supabaseProjectRef: props.supabaseProjectRef,
      tenantMembershipTable: this.tenantMembership.table,
    });

    this.uploadApi = new UploadApi(this, "UploadApi", {
      envName: this.envName,
      uploadHandler: this.uploadPipeline.uploadHandler,
      userPool: this.identity.userPool,
      userPoolClient: this.identity.userPoolClient,
    });

    // Document list/get/delete API (multi-tenant design §4.2 extension).
    const documentsHandler = new lambdaNode.NodejsFunction(this, "DocumentsHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../lambda/documents-handler/index.ts"),
      handler: "handler",
      environment: {
        DOCUMENT_REGISTRY_TABLE_NAME: this.documentRegistry.table.tableName,
        DOCUMENTS_BUCKET_NAME: this.uploadPipeline.bucket.bucketName,
      },
      timeout: cdk.Duration.seconds(10),
    });
    this.documentRegistry.table.grantReadWriteData(documentsHandler);
    this.uploadPipeline.bucket.grantDelete(documentsHandler);

    this.documentsApi = new DocumentsApi(this, "DocumentsApi", {
      envName: this.envName,
      documentsHandler,
      userPool: this.identity.userPool,
      userPoolClient: this.identity.userPoolClient,
      documentsBucket: this.uploadPipeline.bucket,
      registryTable: this.documentRegistry.table,
    });

    // Public (no-auth) API documentation endpoint.
    this.docsApi = new DocsApi(this, "DocsApi", {
      envName: this.envName,
    });

    // Per-tenant department + tag catalog API (admin-managed dropdowns and
    // normalized tag vocabulary).
    const catalogHandler = new lambdaNode.NodejsFunction(this, "CatalogHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../lambda/catalog-handler/index.ts"),
      handler: "handler",
      environment: {
        TENANT_CATALOG_TABLE_NAME: this.tenantCatalog.table.tableName,
        TENANT_MEMBERSHIP_TABLE_NAME: this.tenantMembership.table.tableName,
        ENV_NAME: this.envName,
      },
      timeout: cdk.Duration.seconds(10),
    });
    this.tenantCatalog.table.grantReadWriteData(catalogHandler);
    this.tenantMembership.table.grantReadData(catalogHandler);

    this.catalogApi = new CatalogApi(this, "CatalogApi", {
      envName: this.envName,
      catalogHandler,
      userPool: this.identity.userPool,
      userPoolClient: this.identity.userPoolClient,
    });

    // Per-tenant member management API (multi-user support): invite, list,
    // accept, and remove members.
    const membersHandler = new lambdaNode.NodejsFunction(this, "MembersHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../lambda/members-handler/index.ts"),
      handler: "handler",
      environment: {
        TENANT_MEMBERSHIP_TABLE_NAME: this.tenantMembership.table.tableName,
        ENV_NAME: this.envName,
      },
      timeout: cdk.Duration.seconds(10),
    });
    this.tenantMembership.table.grantReadWriteData(membersHandler);

    this.membersApi = new MembersApi(this, "MembersApi", {
      envName: this.envName,
      membersHandler,
      userPool: this.identity.userPool,
      userPoolClient: this.identity.userPoolClient,
    });

    // Name-based organization creation (Google-account flow): check name
    // availability and create an org + admin membership.
    const organizationsHandler = new lambdaNode.NodejsFunction(this, "OrganizationsHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../lambda/organizations-handler/index.ts"),
      handler: "handler",
      environment: {
        ORGANIZATION_TABLE_NAME: this.organization.table.tableName,
        TENANT_MEMBERSHIP_TABLE_NAME: this.tenantMembership.table.tableName,
      },
      timeout: cdk.Duration.seconds(10),
    });
    this.organization.table.grantReadWriteData(organizationsHandler);
    this.tenantMembership.table.grantReadWriteData(organizationsHandler);

    this.organizationsApi = new OrganizationsApi(this, "OrganizationsApi", {
      envName: this.envName,
      organizationsHandler,
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

