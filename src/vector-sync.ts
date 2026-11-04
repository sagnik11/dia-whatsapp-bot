import type { SqlExecutor } from "./cloudflare-d1.js";
import { SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";
import type { SemanticIndex, SemanticItem } from "./patch-api-client.js";
import type { ScheduledJob } from "./tool-module.js";

/** Keep in sync with migrations/0006_platform.sql (a test enforces this). */
export const PLATFORM_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS vector_sync_state (
  source TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)`,
];

/** Tasks are company-wide, so they are indexed under this group id. */
export const COMPANY_WIDE_GROUP = "*";
export const VECTOR_SYNC_INTERVAL_MS = 10 * 60 * 1_000;

export type VectorSourceName = "memory" | "task";

interface MemoryRow {
  id: number;
  group_id: string;
  kind: string;
  subject: string;
  content: string;
  source_author: string | null;
  observed_at: string;
}

interface TaskRow {
  id: number;
  title: string;
  notes: string | null;
  owner: string | null;
  area: string | null;
  tags: string | null;
}

interface SourceBatch {
  lastId: number;
  items: SemanticItem[];
}

function parseTags(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export function memoryVectorItem(row: MemoryRow): SemanticItem {
  return {
    id: `memory:${row.id}`,
    text: [`${row.kind} about ${row.subject}: ${row.content}`, row.source_author ? `Said by ${row.source_author}.` : ""]
      .filter(Boolean)
      .join(" "),
    metadata: {
      group_id: row.group_id,
      kind: "memory",
      ref: `M${row.id}`,
      memory_kind: row.kind,
      subject: row.subject.slice(0, 120),
      observed_at: row.observed_at,
    },
  };
}

export function taskVectorItem(row: TaskRow): SemanticItem {
  const tags = parseTags(row.tags);
  return {
    id: `task:${row.id}`,
    text: [
      `Task: ${row.title}`,
      row.owner ? `Owner: ${row.owner}` : "",
      row.area ? `Area: ${row.area}` : "",
      tags.length > 0 ? `Tags: ${tags.join(", ")}` : "",
      row.notes ? `Notes: ${row.notes.slice(0, 3_000)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    metadata: {
      group_id: COMPANY_WIDE_GROUP,
      kind: "task",
      ref: `#${row.id}`,
      title: row.title.slice(0, 120),
    },
  };
}

interface VectorSyncOptions {
  db: SqlExecutor;
  index: Pick<SemanticIndex, "upsert">;
  logger: Logger;
  intervalMs?: number;
  /** Rows read and upserted per round trip. */
  batchSize?: number;
  /** Caps one run so a large backfill spreads over several runs. */
  maxBatchesPerRun?: number;
  now?: () => Date;
}

/**
 * Silent background job: copies new long-term memories and tasks into
 * Vectorize. A per-source high-water mark in D1 (`vector_sync_state`) means
 * each row is embedded once; vector ids (`memory:<id>`, `task:<id>`) make a
 * repeated upsert after a crash harmless. Soft-deleted rows are skipped.
 */
export class VectorSyncJob implements ScheduledJob {
  public readonly name = "vector sync";
  public readonly intervalMs: number;
  private readonly schema: SchemaGate;

  public constructor(private readonly options: VectorSyncOptions) {
    this.intervalMs = options.intervalMs ?? VECTOR_SYNC_INTERVAL_MS;
    this.schema = new SchemaGate(options.db, PLATFORM_SCHEMA_STATEMENTS, options.logger, "Platform");
  }

  public async run(): Promise<void> {
    const synced = await this.syncAll();
    if (synced.memory + synced.task > 0) {
      this.options.logger.info(synced, "Synced memories and tasks into semantic memory");
    }
  }

  /** Returns how many items each source upserted. A failing source does not block the other. */
  public async syncAll(): Promise<Record<VectorSourceName, number>> {
    await this.schema.ensure();
    const synced: Record<VectorSourceName, number> = { memory: 0, task: 0 };
    for (const source of ["memory", "task"] as const) {
      try {
        synced[source] = await this.syncSource(source);
      } catch (error) {
        this.options.logger.error({ error, source }, "Semantic sync failed; it will resume from the last saved mark");
      }
    }
    return synced;
  }

  public async lastId(source: VectorSourceName): Promise<number> {
    await this.schema.ensure();
    const result = await this.options.db.query<{ last_id: number }>(
      "SELECT last_id FROM vector_sync_state WHERE source = ?",
      [source],
    );
    return Number(result.results[0]?.last_id ?? 0);
  }

  private async syncSource(source: VectorSourceName): Promise<number> {
    const batchSize = this.options.batchSize ?? 100;
    const maxBatches = this.options.maxBatchesPerRun ?? 5;
    let total = 0;
    for (let round = 0; round < maxBatches; round += 1) {
      const afterId = await this.lastId(source);
      const batch = await this.fetch(source, afterId, batchSize);
      if (batch.items.length === 0) break;
      await this.options.index.upsert(batch.items);
      // Only after a successful upsert, and never backwards.
      await this.options.db.query(
        `INSERT INTO vector_sync_state (source, last_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (source) DO UPDATE SET
           last_id = MAX(vector_sync_state.last_id, excluded.last_id),
           updated_at = excluded.updated_at`,
        [source, batch.lastId, (this.options.now?.() ?? new Date()).toISOString()],
      );
      total += batch.items.length;
      if (batch.items.length < batchSize) break;
    }
    return total;
  }

  private async fetch(source: VectorSourceName, afterId: number, limit: number): Promise<SourceBatch> {
    if (source === "memory") {
      const result = await this.options.db.query<MemoryRow>(
        `SELECT id, group_id, kind, subject, content, source_author, observed_at FROM memories
         WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT ${limit}`,
        [afterId],
      );
      return {
        lastId: Math.max(afterId, ...result.results.map((row) => Number(row.id))),
        items: result.results.map(memoryVectorItem),
      };
    }
    const result = await this.options.db.query<TaskRow>(
      `SELECT id, title, notes, owner, area, tags FROM tasks
       WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT ${limit}`,
      [afterId],
    );
    return {
      lastId: Math.max(afterId, ...result.results.map((row) => Number(row.id))),
      items: result.results.map(taskVectorItem),
    };
  }
}
