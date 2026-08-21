import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
  type InvokeAgentCommandInput,
  type KnowledgeBaseConfiguration,
  type RetrievalFilter,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { tenantOrgWide } from "../common/auth";

/**
 * Invokes the Bedrock Agent with a mandatory tenant + department metadata
 * filter (multi-tenant design §4.3). The filter is applied at the
 * vector-search level via `sessionState.knowledgeBaseConfigurations` — a
 * hard retrieval constraint, not a prompt hint.
 *
 * The filter is `andAll` of:
 *   - `tenantId` equals the user's tenant (from the verified JWT)
 *   - `department` in (user's departments + the tenant's org-wide scope)
 *
 * A missing/empty tenant fails closed — no Bedrock call is made.
 */

let client: BedrockAgentRuntimeClient;

export interface AgentInvokeInput {
  agentId: string;
  agentAliasId: string;
  knowledgeBaseId: string;
  sessionId: string;
  message: string;
  tenantId: string;
  departments: string[];
  /** Optional tag filter — narrows retrieval to documents carrying any of these tags. */
  tags?: string[];
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

/** Thrown when the tenant scope is missing/empty — fail closed, no retrieval. */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

/**
 * Builds the mandatory retrieval filter. `tenantId` is non-negotiable; the
 * department list always includes the tenant's org-wide scope. When `tags`
 * is non-empty, an additional `tags IN (...)` clause narrows retrieval to
 * documents carrying at least one of the requested tags.
 */
export function buildRetrievalFilter(
  tenantId: string,
  departments: string[],
  tags?: string[]
): RetrievalFilter {
  if (!tenantId || tenantId.trim().length === 0) {
    throw new TenantScopeError("tenantId is required for retrieval scoping");
  }

  const scopedDepartments = Array.from(
    new Set([...departments, tenantOrgWide(tenantId)])
  );
  if (scopedDepartments.length === 0) {
    throw new TenantScopeError("department scope is empty (fail closed)");
  }

  const clauses: RetrievalFilter["andAll"] = [
    { equals: { key: "tenantId", value: tenantId } },
    { in: { key: "department", value: scopedDepartments } },
  ];

  const normalizedTags = Array.from(new Set((tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0)));
  if (normalizedTags.length > 0) {
    clauses.push({ in: { key: "tags", value: normalizedTags } });
  }

  return { andAll: clauses };
}

/**
 * Builds the `sessionState.knowledgeBaseConfigurations` entry carrying the
 * retrieval filter for the given knowledge base.
 */
export function buildKnowledgeBaseConfiguration(
  knowledgeBaseId: string,
  filter: RetrievalFilter
): KnowledgeBaseConfiguration {
  return {
    knowledgeBaseId,
    retrievalConfiguration: {
      vectorSearchConfiguration: { filter },
    },
  };
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

  // Build the mandatory filter BEFORE any Bedrock call — a missing tenant
  // throws here and never reaches the network.
  const filter = buildRetrievalFilter(input.tenantId, input.departments, input.tags);
  const knowledgeBaseConfigurations = [
    buildKnowledgeBaseConfiguration(input.knowledgeBaseId, filter),
  ];

  const commandInput: InvokeAgentCommandInput = {
    agentId: input.agentId,
    agentAliasId: input.agentAliasId,
    sessionId: input.sessionId,
    inputText: input.message,
    sessionState: {
      knowledgeBaseConfigurations,
    },
  };

  const command = new InvokeAgentCommand(commandInput);
  const response = await client.send(command);

  // The Bedrock Agent streams the response — iterate over completion events.
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
