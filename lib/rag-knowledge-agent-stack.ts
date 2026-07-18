import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { UploadPipeline } from "./constructs/upload-pipeline";
import { KbSync } from "./constructs/kb-sync";
import { ConversationHistory } from "./constructs/conversation-history";
import { Identity } from "./constructs/identity";

export interface RagKnowledgeAgentStackProps extends cdk.StackProps {
  /** Deployment environment name: dev | staging | prod */
  envName: string;
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
    // environment. These parameter names/placeholders let the stack synth
    // independently of that manual setup having happened yet.
    this.identity = new Identity(this, "Identity", {
      envName: this.envName,
      googleClientId: "PENDING-GOOGLE-OAUTH-CLIENT-ID",
      googleClientSecretParam: `/rag-knowledge-agent/${this.envName}/google-client-secret`,
      googleServiceAccountKeyParam: `/rag-knowledge-agent/${this.envName}/google-service-account-key`,
      googleWorkspaceAdminEmail: `admin@${this.envName}.pending-setup.invalid`,
    });
  }
}
