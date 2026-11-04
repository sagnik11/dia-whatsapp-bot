import OpenAI from "openai";
import type { Logger } from "./logger.js";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CompletionRequest {
  system: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolDefinition[];
  /**
   * "required" makes the model call at least one offered tool. A name offers
   * only that tool and requires it, which works even on models that do not
   * honor named tool_choice.
   */
  toolChoice?: "auto" | "required" | { name: string };
  maxTokens?: number;
  /** Overrides the configured reasoning effort for the primary model. */
  reasoningEffort?: string;
  /** Small, non-sensitive labels attached to the AI Gateway log entry. */
  metadata?: Readonly<Record<string, string>>;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  truncated: boolean;
  /** The assistant turn to replay into history before tool outputs. */
  message: ChatMessage;
  model: string;
}

export interface LanguageModel {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export function cloudflareAiBaseUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`;
}

interface CloudflareGatewayModelOptions {
  accountId: string;
  gatewayId: string;
  apiToken: string;
  model: string;
  fallbackModel?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  /** Test seam: replaces the HTTP transport, not the request building. */
  fetch?: typeof fetch;
  logger: Logger;
}

function toOpenAiTool(tool: ToolDefinition): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Some open models answer a tool request with the call serialized as plain
 * text. Recover it only when the whole reply is one call to an offered tool.
 */
export function recoverTextToolCall(
  text: string,
  tools: readonly ToolDefinition[],
): ToolCall | null {
  const candidate = text
    .trim()
    .replace(/^<tool_call>\s*|\s*<\/tool_call>$/g, "")
    .replace(/^```(?:json)?\s*|\s*```$/g, "")
    .trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : null;
  const args = record.arguments ?? record.parameters;
  if (!name || !tools.some((tool) => tool.name === name)) return null;
  const serialized =
    typeof args === "string" ? args : JSON.stringify(args ?? {});
  return { id: "recovered_call_0", name, arguments: serialized };
}

function isFallbackWorthy(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    return error.status === undefined || error.status === 429 || error.status >= 500;
  }
  return error instanceof OpenAI.APIConnectionError;
}

/**
 * Chat Completions against Workers AI, routed through AI Gateway via
 * Cloudflare's account REST endpoint (`cf-aig-gateway-id` selects the
 * gateway for logging, caching, rate limiting, and analytics).
 */
export class CloudflareGatewayModel implements LanguageModel {
  private readonly client: OpenAI;

  public constructor(private readonly options: CloudflareGatewayModelOptions) {
    this.client = new OpenAI({
      apiKey: options.apiToken,
      baseURL: cloudflareAiBaseUrl(options.accountId),
      defaultHeaders: { "cf-aig-gateway-id": options.gatewayId },
      timeout: options.timeoutMs ?? 120_000,
      maxRetries: 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  public async complete(request: CompletionRequest): Promise<CompletionResult> {
    const models = [this.options.model, this.options.fallbackModel].filter(
      (model, index, all): model is string =>
        Boolean(model) && all.indexOf(model) === index,
    );
    for (const [index, model] of models.entries()) {
      try {
        return await this.completeWith(model, request, index === 0);
      } catch (error) {
        const next = models[index + 1];
        if (!next || !isFallbackWorthy(error)) throw error;
        this.options.logger.warn(
          { error, model, fallbackModel: next },
          "Primary model unavailable; retrying on the fallback model",
        );
      }
    }
    throw new Error("No language model is configured");
  }

  private async completeWith(
    model: string,
    request: CompletionRequest,
    isPrimary: boolean,
  ): Promise<CompletionResult> {
    const choice = request.toolChoice ?? "auto";
    const offered =
      typeof choice === "object"
        ? (request.tools ?? []).filter((tool) => tool.name === choice.name)
        : (request.tools ?? []);
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: [{ role: "system", content: request.system }, ...request.messages],
      ...(offered.length > 0
        ? {
            tools: offered.map(toOpenAiTool),
            tool_choice: choice === "auto" ? "auto" : "required",
          }
        : {}),
      ...(request.maxTokens ? { max_completion_tokens: request.maxTokens } : {}),
    };
    const reasoningEffort = request.reasoningEffort ?? this.options.reasoningEffort;
    if (isPrimary && reasoningEffort) {
      (body as unknown as Record<string, unknown>).reasoning_effort = reasoningEffort;
    }

    const completion = await this.client.chat.completions.create(
      body,
      request.metadata
        ? { headers: { "cf-aig-metadata": JSON.stringify(request.metadata) } }
        : undefined,
    );
    const first = completion.choices[0];
    const rawContent = first?.message.content;
    let text = typeof rawContent === "string" ? stripReasoning(rawContent) : "";
    let toolCalls: ToolCall[] = (first?.message.tool_calls ?? []).flatMap(
      (call, index) =>
        call.type === "function"
          ? [
              {
                id: call.id || `call_${index}`,
                name: call.function.name,
                arguments: call.function.arguments || "{}",
              },
            ]
          : [],
    );
    if (toolCalls.length === 0 && offered.length > 0) {
      const recovered = recoverTextToolCall(text, offered);
      if (recovered) {
        toolCalls = [recovered];
        text = "";
      }
    }

    const message: ChatMessage = {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
    return {
      text,
      toolCalls,
      truncated: first?.finish_reason === "length",
      message,
      model,
    };
  }
}
