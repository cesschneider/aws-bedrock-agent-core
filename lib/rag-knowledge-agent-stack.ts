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
   * ARN of the S3 Vectors index backing the Bedrock Knowledge Base. S3
   * Vectors has no CDK support yet, so the index is provisioned outside this
   * stack (Phase 0 spike outcome) and passed in. When omitted, the
   * KnowledgeBase construct is skipped and kb-sync keeps its placeholder IDs
   * — this keeps synth/deploy working until the index exists per env.
   */
  vectorIndexArn?: string;
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
  public readonly knowledgeBase?: KnowledgeBase;
  public readonly ragAgent?: RagAgent;
  public readonly uploadApi: UploadApi;

  constructor(scope: Construct, id: string, props: RagKnowledgeAgentStackProps) {
    super(scope, id, props);
    this.envName = props.envName;

    cdk.Tags.of(this).add("project", "rag-knowledge-agent");
    cdk.Tags.of(this).add("environment", this.envName);

    this.uploadPipeline = new UploadPipeline(this, "UploadPipeline", {
      envName: this.envName,
    });

    // The Knowledge Base needs an S3 Vectors index ARN, provisioned outside
    // CDK per environment (Phase 0 spike outcome). Until it's supplied via
    // props/context, kb-sync runs with placeholder IDs and the KB construct
    // is skipped so synth/deploy stay green.
    const vectorIndexArn =
      props.vectorIndexArn ?? this.node.tryGetContext("vectorIndexArn");
    if (vectorIndexArn) {
      this.knowledgeBase = new KnowledgeBase(this, "KnowledgeBase", {
        envName: this.envName,
        sourceBucket: this.uploadPipeline.bucket,
        vectorIndexArn,
      });

      this.ragAgent = new RagAgent(this, "RagAgent", {
        envName: this.envName,
        knowledgeBaseId: this.knowledgeBase.knowledgeBase.attrKnowledgeBaseId,
        knowledgeBaseArn: this.knowledgeBase.knowledgeBase.attrKnowledgeBaseArn,
      });
    }

    this.kbSync = new KbSync(this, "KbSync", {
      envName: this.envName,
      sourceBucket: this.uploadPipeline.bucket,
      knowledgeBaseId:
        this.knowledgeBase?.knowledgeBase.attrKnowledgeBaseId ?? "PENDING-KB-CONSTRUCT",
      dataSourceId:
        this.knowledgeBase?.dataSource.attrDataSourceId ?? "PENDING-DATA-SOURCE-CONSTRUCT",
    });

    this.conversationHistory = new ConversationHistory(this, "ConversationHistory", {
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

    this.identity = new Identity(this, "Identity", {
      envName: this.envName,
      googleClientId: "PENDING-GOOGLE-OAUTH-CLIENT-ID",
      googleClientSecret,
      googleServiceAccountKeyParam: `/rag-knowledge-agent/${this.envName}/google-service-account-key`,
      googleWorkspaceAdminEmail: `admin@${this.envName}.pending-setup.invalid`,
    });

    this.chatHandler = new ChatHandler(this, "ChatHandler", {
      envName: this.envName,
      conversationTable: this.conversationHistory.table,
      documentsBucket: this.uploadPipeline.bucket,
      cognitoUserPoolId: this.identity.userPool.userPoolId,
      cognitoClientId: this.identity.userPoolClient.userPoolClientId,
      agentId: this.ragAgent?.agent.attrAgentId,
      agentAliasId: this.ragAgent?.agentAlias.attrAgentAliasId,
    });

    this.uploadApi = new UploadApi(this, "UploadApi", {
      envName: this.envName,
      uploadHandler: this.uploadPipeline.uploadHandler,
      userPool: this.identity.userPool,
      userPoolClient: this.identity.userPoolClient,
    });
  }
}
