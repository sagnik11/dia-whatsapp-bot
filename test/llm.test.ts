import { describe, expect, it, vi } from "vitest";
import {
  CloudflareGatewayModel,
  cloudflareAiBaseUrl,
  recoverTextToolCall,
  type ToolDefinition,
} from "../src/llm.js";

const tool: ToolDefinition = {
  name: "list_tasks",
  description: "List tasks",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
const otherTool: ToolDefinition = { ...tool, name: "create_tasks" };

function completion(message: Record<string, unknown>, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "@cf/moonshotai/kimi-k2.6",
      choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", ...message } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function captureFetch(...responses: Response[]) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error("No scripted response left");
    return next;
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

function model(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new CloudflareGatewayModel({
    accountId: "acct-123",
    gatewayId: "patch-gateway",
    apiToken: "cf-token",
    model: "@cf/moonshotai/kimi-k2.6",
    fallbackModel: "@cf/google/gemma-4-26b-a4b-it",
    reasoningEffort: "none",
    fetch: fetchImpl,
    logger: { warn: vi.fn() } as never,
    ...extra,
  });
}

describe("CloudflareGatewayModel", () => {
  it("calls Workers AI chat completions through the AI Gateway REST endpoint", async () => {
    const { fetch, calls } = captureFetch(
      completion({
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_tasks", arguments: "{}" } },
        ],
      }),
    );

    const result = await model(fetch).complete({
      system: "You are Patch.",
      messages: [{ role: "user", content: "what's due?" }],
      tools: [tool, otherTool],
      toolChoice: "required",
      metadata: { feature: "chat" },
    });

    const [call] = calls;
    expect(call?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/chat/completions",
    );
    expect(call?.headers.get("authorization")).toBe("Bearer cf-token");
    expect(call?.headers.get("cf-aig-gateway-id")).toBe("patch-gateway");
    expect(call?.headers.get("cf-aig-metadata")).toBe('{"feature":"chat"}');
    expect(call?.body).toMatchObject({
      model: "@cf/moonshotai/kimi-k2.6",
      tool_choice: "required",
      reasoning_effort: "none",
      messages: [
        { role: "system", content: "You are Patch." },
        { role: "user", content: "what's due?" },
      ],
    });
    expect((call?.body.tools as unknown[]).length).toBe(2);
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "list_tasks", arguments: "{}" }]);
    expect(result.message).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
  });

  it("offers only the named tool when one specific tool is required", async () => {
    const { fetch, calls } = captureFetch(completion({ content: "ok" }));
    await model(fetch).complete({
      system: "s",
      messages: [{ role: "user", content: "u" }],
      tools: [tool, otherTool],
      toolChoice: { name: "create_tasks" },
    });
    expect(calls[0]?.body.tool_choice).toBe("required");
    expect(calls[0]?.body.tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "create_tasks" }) }),
    ]);
  });

  it("falls back to the second model when the primary is rate limited", async () => {
    const { fetch, calls } = captureFetch(
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "x-should-retry": "false" },
      }),
      completion({ content: "<think>hmm</think>All clear." }),
    );

    const result = await model(fetch).complete({
      system: "s",
      messages: [{ role: "user", content: "u" }],
    });

    expect(calls.map((call) => call.body.model)).toEqual([
      "@cf/moonshotai/kimi-k2.6",
      "@cf/google/gemma-4-26b-a4b-it",
    ]);
    // Reasoning controls are model specific, so the fallback does not get them.
    expect(calls[1]?.body.reasoning_effort).toBeUndefined();
    expect(result).toMatchObject({ text: "All clear.", model: "@cf/google/gemma-4-26b-a4b-it" });
  });

  it("does not hide client errors behind the fallback model", async () => {
    const { fetch, calls } = captureFetch(
      new Response(JSON.stringify({ error: { message: "bad tool schema" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      model(fetch).complete({ system: "s", messages: [{ role: "user", content: "u" }] }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("flags a length-truncated reply", async () => {
    const { fetch } = captureFetch(completion({ content: "Half a sen" }, "length"));
    const result = await model(fetch).complete({
      system: "s",
      messages: [{ role: "user", content: "u" }],
    });
    expect(result.truncated).toBe(true);
  });

  it("recovers a tool call that an open model wrote as plain JSON", async () => {
    const { fetch } = captureFetch(
      completion({ content: '```json\n{"name":"list_tasks","arguments":{"overdue_only":true}}\n```' }),
    );
    const result = await model(fetch).complete({
      system: "s",
      messages: [{ role: "user", content: "u" }],
      tools: [tool],
    });
    expect(result.toolCalls).toEqual([
      { id: "recovered_call_0", name: "list_tasks", arguments: '{"overdue_only":true}' },
    ]);
    expect(result.text).toBe("");
  });
});

describe("recoverTextToolCall", () => {
  it("ignores prose and tools that were not offered", () => {
    expect(recoverTextToolCall("Sure, here are your tasks.", [tool])).toBeNull();
    expect(recoverTextToolCall('{"name":"drop_database","arguments":{}}', [tool])).toBeNull();
  });
});

describe("cloudflareAiBaseUrl", () => {
  it("encodes the account id", () => {
    expect(cloudflareAiBaseUrl("a/b")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/a%2Fb/ai/v1",
    );
  });
});
