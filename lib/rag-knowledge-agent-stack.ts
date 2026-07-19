import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { UploadPipeline } from "./constructs/upload-pipeline";
import { KbSync } from "./constructs/kb-sync";
import { ConversationHistory } from "./constructs/conversation-history";
import { Identity } from "./constructs/identity";
import { ChatHandler } from "./constructs/chat-handler";

export interface RagKnowledgeAgentStackProps extends cdk.StackProps {
  /** Deployment environment slug: dev | stg | prd */
  envName: string;
  /**
   * Optional pre-resolved Google OAuth client secret. If omitted, the stack
   * resolves it at synthesis time via ssm.StringParameter.valueFromLookup.
   * Useful in tests where SSM context resolution isn't available.
   */
  googleClientSecretOverride?: string;
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

  constructor(scope: Construct, id: string, props: RagKnowledgeAgentStackProps) {
    super(scope, id, props);
    this.envName = props.envName;

    cdk.Tags.of(this).add("project", "rag-knowledge-agent");
    cdk.Tags.of(this).add("environment", this.envName);

    this.uploadPipeline = new UploadPipeline(this, "UploadPipeline", {
      envName: this.envName,
    });

    this.kbSync = new KbSync(this, "KbSync", {
      envName: this.envName,
      sourceBucket: this.uploadPipeline.bucket,
      // Placeholders until the Bedrock Knowledge Base construct (task #5,
      // blocked on the Phase 0 S3 Vectors spike) supplies the real IDs.
      knowledgeBaseId: "PENDING-KB-CONSTRUCT",
      dataSourceId: "PENDING-DATA-SOURCE-CONSTRUCT",
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
    });
  }
}
