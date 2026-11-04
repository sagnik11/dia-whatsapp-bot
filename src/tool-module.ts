import type { ToolDefinition } from "./llm.js";
import type { ToolOutcome } from "./tool-outcome.js";
import type { AssistantRequest } from "./types.js";

/** Handles one WhatsApp request's calls for a module, with per-request state. */
export interface ToolSession {
  /** Return null when the tool name does not belong to this module. */
  handle(name: string, args: unknown): Promise<ToolOutcome | null>;
}

/**
 * A self-contained capability plugged into the assistant: its tools, the
 * instructions that teach the model when to use them, an optional intent
 * detector that forces a tool call, and a per-request session.
 */
export interface ToolModule {
  readonly name: string;
  readonly tools: readonly ToolDefinition[];
  readonly instructions: readonly string[];
  /** True when the message clearly asks for this module's action. */
  detect?(message: string): boolean;
  /**
   * Start a request. `knownTaskIds` is shared with the core task tools: add
   * ids you list, and only act on ids it contains.
   */
  begin(request: AssistantRequest, knownTaskIds: Set<number>): ToolSession;
}

export type SendMessage = (groupId: string, message: string) => Promise<void>;

/** A background job run by the scheduler at most once per interval. */
export interface ScheduledJob {
  readonly name: string;
  readonly intervalMs: number;
  run(nowMs: number, send: SendMessage): Promise<void>;
}
