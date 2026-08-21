import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/**
 * Handler-level integration tests for the chat flow (spec Section 4.4).
 * Bedrock, DynamoDB, S3 presigning, and JWT validation are mocked at module
 * boundaries; what's under test is the handler's orchestration:
 * auth → validate → persist user turn → invoke agent → persist assistant
 * turn → respond (including the zero-result path and write-before-stream).
 */

const mockAuthenticate = jest.fn();
jest.mock("./jwt-auth", () => ({
  init: jest.fn(),
  authenticate: (...args: unknown[]) => mockAuthenticate(...args),
}));

const mockInvokeAgent = jest.fn();
jest.mock("./agent-invoke", () => ({
  invokeAgent: (...args: unknown[]) => mockInvokeAgent(...args),
}));

const mockPresignCitation = jest.fn();
jest.mock("./citations", () => ({
  presignCitation: (...args: unknown[]) => mockPresignCitation(...args),
}));

const mockAppendTurn = jest.fn();
const mockConversationPartitionKey = jest.fn((tenantId: string, userId: string) => `${tenantId}#${userId}`);
jest.mock("../common/conversation-store", () => ({
  appendTurn: (...args: unknown[]) => mockAppendTurn(...args),
  conversationPartitionKey: (tenantId: unknown, userId: unknown) =>
    mockConversationPartitionKey(tenantId as string, userId as string),
}));

import { handler } from "./index";

function makeEvent(body: unknown, authHeader = "Bearer valid-token"): APIGatewayProxyEventV2 {
  return {
    headers: { authorization: authHeader },
    body: body === undefined ? undefined : JSON.stringify(body),
  } as unknown as APIGatewayProxyEventV2;
}

async function* agentStream(
  chunks: Array<{ text?: string; citations?: Array<{ referenceId: string; s3Uri: string }> }>
) {
  for (const c of chunks) yield c;
}

const AUTH = { userId: "user-1", tenantId: "acme", departments: ["acme:dept-eng", "acme:org-wide"] };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthenticate.mockResolvedValue(AUTH);
  mockAppendTurn.mockResolvedValue(undefined);
  mockPresignCitation.mockResolvedValue({ referenceId: "ref-1", url: "https://signed/doc" });
});

describe("chat handler", () => {
  it("returns the streamed answer with citations and persists both turns", async () => {
    mockInvokeAgent.mockReturnValue(
      agentStream([
        { text: "Grounded " },
        { text: "answer." },
        { citations: [{ referenceId: "ref-1", s3Uri: "s3://b/dept-eng/doc.pdf" }] },
      ])
    );

    const res = (await handler(
      makeEvent({ message: "What is our policy?" })
    )) as APIGatewayProxyStructuredResultV2;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.answer).toBe("Grounded answer.");
    expect(body.citations).toEqual([{ referenceId: "ref-1", url: "https://signed/doc" }]);
    // Write-before-stream: user turn first, assistant turn after.
    expect(mockAppendTurn).toHaveBeenCalledTimes(2);
    const roles = mockAppendTurn.mock.calls.map((c) => c[2].role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("returns the explicit no-documents message when the agent streams nothing", async () => {
    mockInvokeAgent.mockReturnValue(agentStream([]));

    const res = (await handler(
      makeEvent({ message: "Anything?" })
    )) as APIGatewayProxyStructuredResultV2;

    const body = JSON.parse(res.body as string);
    expect(res.statusCode).toBe(200);
    expect(body.answer).toContain("No relevant company documents were found");
  });

  it("passes the user's tenant and departments to the agent invocation", async () => {
    mockInvokeAgent.mockReturnValue(agentStream([{ text: "ok" }]));
    await handler(makeEvent({ message: "hi" }));
    expect(mockInvokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: AUTH.tenantId, departments: AUTH.departments })
    );
  });

  it("narrows the department filter to a requested subset the caller belongs to", async () => {
    mockInvokeAgent.mockReturnValue(agentStream([{ text: "ok" }]));
    await handler(makeEvent({ message: "hi", departments: ["acme:dept-eng"] }));
    expect(mockInvokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ departments: ["acme:dept-eng"] })
    );
  });

  it("rejects a department filter the caller does not belong to (403)", async () => {
    mockInvokeAgent.mockReturnValue(agentStream([{ text: "ok" }]));
    const res = (await handler(
      makeEvent({ message: "hi", departments: ["acme:dept-hr"] })
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(403);
    expect(mockInvokeAgent).not.toHaveBeenCalled();
  });

  it("passes tags through to the agent invocation", async () => {
    mockInvokeAgent.mockReturnValue(agentStream([{ text: "ok" }]));
    await handler(makeEvent({ message: "hi", tags: ["finance", "q3"] }));
    expect(mockInvokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["finance", "q3"] })
    );
  });

  it("rejects non-array tags (400)", async () => {
    mockInvokeAgent.mockReturnValue(agentStream([{ text: "ok" }]));
    const res = (await handler(
      makeEvent({ message: "hi", tags: "finance" })
    )) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
    expect(mockInvokeAgent).not.toHaveBeenCalled();
  });

  it("omits citations the presigner rejects (revoked access)", async () => {
    mockPresignCitation.mockResolvedValue(null);
    mockInvokeAgent.mockReturnValue(
      agentStream([
        { text: "answer" },
        { citations: [{ referenceId: "ref-x", s3Uri: "s3://b/dept-hr/doc.pdf" }] },
      ])
    );

    const res = (await handler(makeEvent({ message: "q" }))) as APIGatewayProxyStructuredResultV2;
    expect(JSON.parse(res.body as string).citations).toEqual([]);
  });

  it("returns 401 when authentication fails and never invokes the agent", async () => {
    mockAuthenticate.mockRejectedValue(
      Object.assign(new Error("Token expired"), { statusCode: 401 })
    );

    const res = (await handler(makeEvent({ message: "q" }))) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(401);
    expect(mockInvokeAgent).not.toHaveBeenCalled();
    expect(mockAppendTurn).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing body", async () => {
    const res = (await handler(makeEvent(undefined))) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for a missing message field", async () => {
    const res = (await handler(makeEvent({ sessionId: "s" }))) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(400);
    expect(mockInvokeAgent).not.toHaveBeenCalled();
  });

  it("fails the request when the user-turn write fails (write-before-stream)", async () => {
    mockAppendTurn.mockRejectedValueOnce(new Error("DynamoDB down"));
    mockInvokeAgent.mockReturnValue(agentStream([{ text: "never streamed" }]));

    const res = (await handler(makeEvent({ message: "q" }))) as APIGatewayProxyStructuredResultV2;
    expect(res.statusCode).toBe(500);
    // Agent must not be invoked if the user turn couldn't be persisted.
    expect(mockInvokeAgent).not.toHaveBeenCalled();
  });

  it("reuses a provided sessionId across the agent call and response", async () => {
    mockInvokeAgent.mockReturnValue(agentStream([{ text: "ok" }]));
    const res = (await handler(
      makeEvent({ message: "q", sessionId: "session-42" })
    )) as APIGatewayProxyStructuredResultV2;

    expect(mockInvokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-42" })
    );
    expect(JSON.parse(res.body as string).sessionId).toBe("session-42");
  });

  it("uses a tenant-scoped partition key for conversation history", async () => {
    mockInvokeAgent.mockReturnValue(agentStream([{ text: "ok" }]));
    await handler(makeEvent({ message: "q" }));
    // Both turns must use the composite key `${tenantId}#${userId}`.
    const partitionKeys = mockAppendTurn.mock.calls.map((c) => c[2].userId);
    expect(partitionKeys).toEqual(["acme#user-1", "acme#user-1"]);
  });
});

