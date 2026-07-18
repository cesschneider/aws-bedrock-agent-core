import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { UploadPipeline } from "./constructs/upload-pipeline";

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

  constructor(scope: Construct, id: string, props: RagKnowledgeAgentStackProps) {
    super(scope, id, props);
    this.envName = props.envName;

    cdk.Tags.of(this).add("project", "rag-knowledge-agent");
    cdk.Tags.of(this).add("environment", this.envName);

    this.uploadPipeline = new UploadPipeline(this, "UploadPipeline", {
      envName: this.envName,
    });
  }
}
