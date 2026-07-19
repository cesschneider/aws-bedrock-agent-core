import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  type InvokeAgentCommandInput,
} from "@aws-sdk/client-bedrock-agent-runtime";

/**
 * Invokes the Bedrock AgentCore agent with department-scoped metadata
 * filtering (spec Section 4.4). The agent performs retrieve-and-generate
 * against the Knowledge Base, filtering chunks to the user's departments
 * plus the reserved "company-wide" department.
 *
 * Placeholder agent/alias IDs are wired as env vars at deploy time — the
 * actual IDs come from the Bedrock Knowledge Base construct (task #5),
 * currently blocked on the Phase 0 S3 Vectors spike.
 */

let client: BedrockAgentRuntimeClient;

export interface AgentInvokeInput {
  agentId: string;
  agentAliasId: string;
  sessionId: string;
  message: string;
  departments: string[];
}

export interface AgentResponseChunk {
  text?: string;
  citations?: Citation[];
}

export interface Citation {
  referenceId: string;
  s3Uri?: string;
  contentType?: string;
}

interface RetrievedReferenceLike {
  s3Location?: { uri?: string };
  location?: { s3Location?: { uri?: string } };
}

function resolveS3Uri(retrievedReference: RetrievedReferenceLike): string | undefined {
  // S3 location from Bedrock KB retrieval — the exact shape depends on the
  // vector store backend (S3 Vectors vs. OpenSearch). Normalize here.
  const loc = retrievedReference?.s3Location ?? retrievedReference?.location?.s3Location;
  if (loc?.uri) return loc.uri;
  return undefined;
}

export async function* invokeAgent(input: AgentInvokeInput): AsyncGenerator<AgentResponseChunk> {
  if (!client) {
    client = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  }

  const commandInput: InvokeAgentCommandInput = {
    agentId: input.agentId,
    agentAliasId: input.agentAliasId,
    sessionId: input.sessionId,
    inputText: input.message,
    // Department-scoped metadata filter: only retrieve chunks tagged for
    // the user's departments (which always includes "company-wide").
    sessionState: {
      promptSessionAttributes: {
        departments: JSON.stringify(input.departments),
      },
    },
  };

  const command = new InvokeAgentCommand(commandInput);
  const response = await client.send(command);

  // Bedrock AgentCore streams the response — iterate over completion events.
  if (response.completion) {
    for await (const event of response.completion) {
      if (event.chunk?.bytes) {
        const text = new TextDecoder().decode(event.chunk.bytes);
        yield { text };
      }
      // Collect citations from the trace events
      if (event.trace?.trace?.orchestrationTrace?.observation?.knowledgeBaseLookupOutput) {
        for (const ref of event.trace.trace.orchestrationTrace.observation
          .knowledgeBaseLookupOutput.retrievedReferences ?? []) {
          const s3Uri = resolveS3Uri(ref);
          if (ref.metadata?.referenceId) {
            yield {
              citations: [
                {
                  referenceId: ref.metadata.referenceId as string,
                  s3Uri,
                  contentType: ref.metadata.contentType as string | undefined,
                },
              ],
            };
          }
        }
      }
    }
  }
}
