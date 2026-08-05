import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { appendTurn, getRecentTurns } from "./conversation-store";

describe("appendTurn", () => {
  it("writes a turn with a computed TTL and no citations attribute when none given", async () => {
    const send = jest.fn().mockResolvedValue({});
    const dynamo = { send } as unknown as DynamoDBClient;

    await appendTurn(dynamo, "conversation-table", {
      userId: "user-1",
      turnId: "2026-07-18T18:00:00Z#abc",
      role: "user",
      message: "What's our vacation policy?",
      createdAt: "2026-07-18T18:00:00Z",
    });

    expect(send).toHaveBeenCalledWith(expect.any(PutItemCommand));
    const call = send.mock.calls[0][0] as PutItemCommand;
    expect(call.input.Item?.userId).toEqual({ S: "user-1" });
    expect(call.input.Item?.citations).toBeUndefined();
    expect(Number(call.input.Item?.expiresAt?.N)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("includes citations when provided", async () => {
    const send = jest.fn().mockResolvedValue({});
    const dynamo = { send } as unknown as DynamoDBClient;

    await appendTurn(dynamo, "conversation-table", {
      userId: "user-1",
      turnId: "2026-07-18T18:00:01Z#def",
      role: "assistant",
      message: "Per the handbook, ...",
      citations: ["dept-hr/uuid-handbook.pdf"],
      createdAt: "2026-07-18T18:00:01Z",
    });

    const call = send.mock.calls[0][0] as PutItemCommand;
    expect(call.input.Item?.citations).toEqual({ SS: ["dept-hr/uuid-handbook.pdf"] });
  });

  it("respects a custom TTL when provided", async () => {
    const send = jest.fn().mockResolvedValue({});
    const dynamo = { send } as unknown as DynamoDBClient;
    const nowSeconds = Math.floor(Date.now() / 1000);

    await appendTurn(
      dynamo,
      "conversation-table",
      {
        userId: "user-1",
        turnId: "t1",
        role: "user",
        message: "hi",
        createdAt: "2026-07-18T18:00:00Z",
      },
      1 // 1 day TTL
    );

    const call = send.mock.calls[0][0] as PutItemCommand;
    const expiresAt = Number(call.input.Item?.expiresAt?.N);
    expect(expiresAt).toBeLessThan(nowSeconds + 2 * 24 * 60 * 60);
    expect(expiresAt).toBeGreaterThan(nowSeconds);
  });
});

describe("getRecentTurns", () => {
  it("maps DynamoDB items back into ConversationTurn objects, most recent first", async () => {
    const send = jest.fn().mockResolvedValue({
      Items: [
        {
          userId: { S: "user-1" },
          turnId: { S: "t2" },
          role: { S: "assistant" },
          message: { S: "Per the handbook, ..." },
          citations: { SS: ["dept-hr/uuid-handbook.pdf"] },
          createdAt: { S: "2026-07-18T18:00:01Z" },
        },
      ],
    });
    const dynamo = { send } as unknown as DynamoDBClient;

    const turns = await getRecentTurns(dynamo, "conversation-table", "user-1", 10);

    expect(send).toHaveBeenCalledWith(expect.any(QueryCommand));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      userId: "user-1",
      turnId: "t2",
      role: "assistant",
      message: "Per the handbook, ...",
      citations: ["dept-hr/uuid-handbook.pdf"],
      createdAt: "2026-07-18T18:00:01Z",
    });
  });

  it("returns an empty array when the user has no history", async () => {
    const send = jest.fn().mockResolvedValue({ Items: undefined });
    const dynamo = { send } as unknown as DynamoDBClient;

    const turns = await getRecentTurns(dynamo, "conversation-table", "user-2");

    expect(turns).toEqual([]);
  });

  it("omits citations when the item has none", async () => {
    const send = jest.fn().mockResolvedValue({
      Items: [
        {
          userId: { S: "user-1" },
          turnId: { S: "t1" },
          role: { S: "user" },
          message: { S: "hi" },
          createdAt: { S: "2026-07-18T18:00:00Z" },
        },
      ],
    });
    const dynamo = { send } as unknown as DynamoDBClient;

    const turns = await getRecentTurns(dynamo, "conversation-table", "user-1");
    expect(turns[0].citations).toBeUndefined();
  });
});

