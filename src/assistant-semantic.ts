import { z } from "zod";
import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import type { ToolDefinition } from "./llm.js";
import type { Logger } from "./logger.js";
import type { SemanticIndex } from "./patch-api-client.js";
import type { ToolModule, ToolSession } from "./tool-module.js";
import { output, type ToolOutcome } from "./tool-outcome.js";
import type { AssistantRequest } from "./types.js";

export const SEMANTIC_KINDS = ["memory", "task", "message", "brain_dump"] as const;
export type SemanticKind = (typeof SEMANTIC_KINDS)[number];
const BASE_KINDS: readonly SemanticKind[] = ["memory", "task"];

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export function isSemanticRequest(message: string): boolean {
  return /\bsemantic(?:ally)?\b|\bwhat (?:have|has) (?:we|anyone|sagnik|tanvi) (?:ever )?(?:said|discussed|decided|noted) (?:about|on|regarding)\b|\b(?:anything|everything) (?:we (?:have|know) )?(?:on|about|related to) /i.test(
    message,
  );
}

const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : value);

const semanticSearchSchema = z.object({
  query: z.string().trim().min(2).max(500),
  kinds: z.array(z.preprocess(lower, z.enum(SEMANTIC_KINDS))).max(SEMANTIC_KINDS.length).nullish(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).nullish(),
});

const KIND_LABELS: Record<SemanticKind, string> = {
  memory: "this group's long-term memory (decisions, commitments, facts, people, preferences)",
  task: "the company task list",
  message: "what founders said in this group's conversation",
  brain_dump: "the Notion Brain Dump",
};

function joinLabels(labels: readonly string[]): string {
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1) ?? ""}`;
}

export function semanticToolDefinitions(kinds: readonly SemanticKind[]): ToolDefinition[] {
  return [
    {
      name: "semantic_search",
      description: `Search by meaning across ${joinLabels(kinds.map((kind) => KIND_LABELS[kind]))}, e.g. 'what have we said about SOC 2?'. Finds related items even when the words differ. Memories come back with M<id> refs and tasks with #<id>; messages with who said them and when; Brain Dump notes with their heading.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The topic or question in plain words." },
          kinds: {
            type: "array",
            items: { type: "string", enum: [...kinds] },
            description: "Limit to some kinds. Default all.",
          },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Default ${DEFAULT_LIMIT}.` },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ];
}

export const SEMANTIC_TOOLS: readonly ToolDefinition[] = semanticToolDefinitions(BASE_KINDS);

export const SEMANTIC_INSTRUCTIONS: readonly string[] = [
  "Semantic memory:",
  "- Prefer semantic_search for fuzzy or conceptual questions ('what have we said about SOC 2?', 'anything on enterprise security?'); it matches meaning, not exact words.",
  "- Use search_memory for exact names, words or recent decisions, list_tasks for task filters (owner, status, due dates), and read_group_conversation for a time window. Items saved in the last ~10 minutes (about an hour for the Brain Dump) may not be in semantic_search yet.",
  "- Cite every match you use: M<id> or #<id>; for a message, who said it and when; for a Brain Dump note, 'Brain Dump' and its heading. Treat low scores as weak matches; never invent items.",
];

interface MemoryRow {
  id: number;
  kind: string;
  subject: string;
  content: string;
  source_author: string | null;
  observed_at: string;
}

interface TaskRow {
  id: number;
  title: string;
  status: string;
  owner: string | null;
  area: string | null;
  due_at: string | null;
  notes: string | null;
}

interface MessageRow {
  id: number;
  author: string;
  body: string;
  sent_at_ms: number;
}

interface ChunkRow {
  chunk_id: string;
  heading: string | null;
  content: string;
}

type Hit =
  | { kind: "memory" | "task" | "message"; id: number; score: number }
  | { kind: "brain_dump"; id: string; score: number };

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function parseVectorId(id: string, score: number): Hit | null {
  const numbered = /^(memory|task|message):(\d{1,12})$/.exec(id);
  if (numbered?.[1] && numbered[2]) {
    return { kind: numbered[1] as "memory" | "task" | "message", id: Number(numbered[2]), score };
  }
  return /^brain:[0-9a-f]{32}$/.test(id) ? { kind: "brain_dump", id, score } : null;
}

interface SemanticToolsOptions {
  index: Pick<SemanticIndex, "query">;
  /** Matches are re-read from D1 so deleted, pruned or other-group items never surface. */
  db: SqlExecutor;
  logger: Logger;
  /** Founders' messages are searchable when the conversation is stored in D1. */
  messages?: boolean;
  /** Brain Dump notes are searchable when the Brain Dump is configured. */
  brainDump?: boolean;
}

/** Phase 3: semantic search over memories, tasks, messages and the Brain Dump, backed by Vectorize. */
export class SemanticTools implements ToolModule {
  public readonly name = "semantic";
  public readonly tools: readonly ToolDefinition[];
  public readonly instructions = SEMANTIC_INSTRUCTIONS;
  private readonly kinds: readonly SemanticKind[];

  public constructor(private readonly options: SemanticToolsOptions) {
    this.kinds = [
      ...BASE_KINDS,
      ...(options.messages ? (["message"] as const) : []),
      ...(options.brainDump ? (["brain_dump"] as const) : []),
    ];
    this.tools = semanticToolDefinitions(this.kinds);
  }

  public detect(message: string): boolean {
    return isSemanticRequest(message);
  }

  public begin(request: AssistantRequest, knownTaskIds: Set<number>): ToolSession {
    return {
      handle: async (name, args) =>
        name === "semantic_search" ? this.search(args, request, knownTaskIds) : null,
    };
  }

  public async search(args: unknown, request: AssistantRequest, knownTaskIds: Set<number>): Promise<ToolOutcome> {
    const parsed = semanticSearchSchema.parse(args);
    const enabled = new Set(this.kinds);
    const requested = (parsed.kinds ?? []).filter((kind) => enabled.has(kind));
    const kinds = new Set<SemanticKind>(requested.length > 0 ? requested : this.kinds);
    const limit = parsed.limit ?? DEFAULT_LIMIT;

    let matches;
    try {
      matches = await this.options.index.query({
        text: parsed.query,
        groupId: request.groupId,
        kind: kinds.size === 1 ? [...kinds][0] ?? null : null,
        topK: Math.min(MAX_LIMIT, limit * 2),
      });
    } catch (error) {
      this.options.logger.warn({ error, messageId: request.messageId }, "Semantic search failed");
      return output({
        error: "Semantic search is unavailable right now. Use search_memory and list_tasks instead.",
      });
    }

    const hits = matches
      .map((match) => parseVectorId(match.id, match.score))
      .filter((hit): hit is Hit => hit !== null && kinds.has(hit.kind));
    const numbered = (kind: "memory" | "task" | "message") =>
      hits.flatMap((hit) => (hit.kind === kind ? [hit.id] : []));
    const memories = await this.memoriesById(request.groupId, numbered("memory"));
    const tasks = await this.tasksById(numbered("task"));
    const messages = await this.messagesById(request.groupId, numbered("message"));
    const notes = await this.chunksById(hits.flatMap((hit) => (hit.kind === "brain_dump" ? [hit.id] : [])));

    const results: Array<Record<string, unknown>> = [];
    for (const hit of hits) {
      if (results.length >= limit) break;
      const score = Math.round(hit.score * 1_000) / 1_000;
      if (hit.kind === "memory") {
        const memory = memories.get(hit.id);
        if (!memory) continue;
        results.push({
          ref: `M${memory.id}`,
          type: "memory",
          score,
          kind: memory.kind,
          subject: memory.subject,
          content: memory.content,
          saidBy: memory.source_author,
          when: memory.observed_at,
        });
      } else if (hit.kind === "message") {
        const message = messages.get(hit.id);
        if (!message) continue;
        results.push({
          type: "message",
          score,
          saidBy: message.author,
          when: new Date(Number(message.sent_at_ms)).toISOString(),
          text: message.body.slice(0, 600),
        });
      } else if (hit.kind === "brain_dump") {
        const note = notes.get(hit.id);
        if (!note) continue;
        results.push({
          ref: "Brain Dump",
          type: "brain_dump",
          score,
          heading: note.heading,
          text: note.content.slice(0, 800),
        });
      } else {
        const task = tasks.get(hit.id);
        if (!task) continue;
        knownTaskIds.add(task.id);
        results.push({
          ref: `#${task.id}`,
          type: "task",
          score,
          title: task.title,
          status: task.status,
          owner: task.owner,
          area: task.area,
          dueAt: task.due_at,
          notes: task.notes ? task.notes.slice(0, 500) : null,
        });
      }
    }
    return output({
      query: parsed.query,
      count: results.length,
      matches: results,
      ...(results.length === 0
        ? { note: "No semantic matches. Try search_memory, list_tasks or read_group_conversation with exact words." }
        : {}),
    });
  }

  private async memoriesById(groupId: string, ids: readonly number[]): Promise<Map<number, MemoryRow>> {
    if (ids.length === 0) return new Map();
    const params: SqlValue[] = [groupId, ...ids];
    const result = await this.options.db.query<MemoryRow>(
      `SELECT id, kind, subject, content, source_author, observed_at FROM memories
       WHERE group_id = ? AND deleted_at IS NULL AND id IN (${placeholders(ids.length)})`,
      params,
    );
    return new Map(result.results.map((row) => [Number(row.id), { ...row, id: Number(row.id) }]));
  }

  private async messagesById(groupId: string, ids: readonly number[]): Promise<Map<number, MessageRow>> {
    if (ids.length === 0) return new Map();
    const result = await this.options.db.query<MessageRow>(
      `SELECT id, author, body, sent_at_ms FROM conversation_messages
       WHERE group_id = ? AND from_bot = 0 AND id IN (${placeholders(ids.length)})`,
      [groupId, ...ids],
    );
    return new Map(result.results.map((row) => [Number(row.id), { ...row, id: Number(row.id) }]));
  }

  private async chunksById(ids: readonly string[]): Promise<Map<string, ChunkRow>> {
    if (ids.length === 0) return new Map();
    const result = await this.options.db.query<ChunkRow>(
      `SELECT chunk_id, heading, content FROM brain_dump_chunks WHERE chunk_id IN (${placeholders(ids.length)})`,
      [...ids],
    );
    return new Map(result.results.map((row) => [row.chunk_id, row]));
  }

  private async tasksById(ids: readonly number[]): Promise<Map<number, TaskRow>> {
    if (ids.length === 0) return new Map();
    const result = await this.options.db.query<TaskRow>(
      `SELECT id, title, status, owner, area, due_at, notes FROM tasks
       WHERE deleted_at IS NULL AND id IN (${placeholders(ids.length)})`,
      [...ids],
    );
    return new Map(result.results.map((row) => [Number(row.id), { ...row, id: Number(row.id) }]));
  }
}
