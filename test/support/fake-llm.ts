import type { CompletionResult } from "../../src/llm.js";

/** A model turn that calls one or more tools. */
export function toolTurn(
  id: string,
  name: string,
  args: unknown,
  ...more: Array<[string, string, unknown]>
): CompletionResult {
  const calls = [[id, name, args] as [string, string, unknown], ...more].map(
    ([callId, callName, callArgs]) => ({
      id: callId,
      name: callName,
      arguments: typeof callArgs === "string" ? callArgs : JSON.stringify(callArgs),
    }),
  );
  return {
    text: "",
    toolCalls: calls,
    truncated: false,
    model: "@cf/test/model",
    message: {
      role: "assistant",
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    },
  };
}

/** A final model turn that only answers in text. */
export function textTurn(text: string): CompletionResult {
  return {
    text,
    toolCalls: [],
    truncated: false,
    model: "@cf/test/model",
    message: { role: "assistant", content: text },
  };
}
