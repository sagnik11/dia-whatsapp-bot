import { z } from "zod";
import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import type { ToolDefinition } from "./llm.js";
import type { Logger } from "./logger.js";
import type { SemanticIndex } from "./patch-api-client.js";
import type { ToolModule, ToolSession } from "./tool-module.js";
import { output, type ToolOutcome } from "./tool-outcome.js";
import type { AssistantRequest } from "./types.js";

export const SEMANTIC_KINDS = ["memory", "task"] as const;
export type SemanticKind = (typeof SEMANTIC_KINDS)[number];

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
  kinds: z.array(z.preprocess(lower, z.enum(SEMANTIC_KINDS))).max(2).nullish(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).nullish(),
});

export const SEMANTIC_TOOLS: readonly ToolDefinition[] = [
  {
    name: "semantic_search",
    description:
      "Search by meaning across this group's long-term memory (decisions, commitments, facts, people, preferences) and the company task list, e.g. 'what have we said about SOC 2?'. Finds related items even when the words differ. Returns matches with refs to cite: M<id> for memories, #<id> for tasks.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The topic or question in plain words." },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...SEMANTIC_KINDS] },
          description: "Limit to memories or tasks. Default both.",
        },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Default ${DEFAULT_LIMIT}.` },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

export const SEMANTIC_INSTRUCTIONS: readonly string[] = [
  "Semantic memory:",
  "- Prefer semantic_search for fuzzy or conceptual questions ('what have we said about SOC 2?', 'anything on enterprise security?') across long-term memory and tasks; it matches meaning, not exact words.",
  "- Use search_memory for exact names, words or recent decisions, and list_tasks for task filters (owner, status, due dates). Items saved in the last ~10 minutes may not be in semantic_search yet.",
  "- Cite every match you use by its ref (M<id> or #<id>), and say who said it and when for memories. Treat low scores as weak matches; never invent items.",
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function parseVectorId(id: string): { kind: SemanticKind; id: number } | null {
  const match = /^(memory|task):(\d{1,12})$/.exec(id);
  if (!match?.[1] || !match[2]) return null;
  return { kind: match[1] as SemanticKind, id: Number(match[2]) };
}

interface SemanticToolsOptions {
  index: Pick<SemanticIndex, "query">;
  /** Matches are re-read from D1 so deleted or other-group items never surface. */
  db: SqlExecutor;
  logger: Logger;
}

/** Phase 3: semantic search over memories and tasks, backed by Vectorize. */
export class SemanticTools implements ToolModule {
  public readonly name = "semantic";
  public readonly tools = SEMANTIC_TOOLS;
  public readonly instructions = SEMANTIC_INSTRUCTIONS;

  public constructor(private readonly options: SemanticToolsOptions) {}

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
    const kinds = new Set<SemanticKind>(parsed.kinds?.length ? parsed.kinds : SEMANTIC_KINDS);
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
      .map((match) => ({ ...parseVectorId(match.id), score: match.score }))
      .filter((hit): hit is { kind: SemanticKind; id: number; score: number } =>
        hit.kind !== undefined && kinds.has(hit.kind),
      );
    const memories = await this.memoriesById(
      request.groupId,
      hits.filter((hit) => hit.kind === "memory").map((hit) => hit.id),
    );
    const tasks = await this.tasksById(hits.filter((hit) => hit.kind === "task").map((hit) => hit.id));

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
        ? { note: "No semantic matches. Try search_memory or list_tasks with exact words." }
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
