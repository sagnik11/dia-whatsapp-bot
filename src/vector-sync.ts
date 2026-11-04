import { createHash } from "node:crypto";
import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import { SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";
import type { SemanticIndex, SemanticItem } from "./patch-api-client.js";
import type { ScheduledJob } from "./tool-module.js";
import type { BrainDumpResult } from "./types.js";

/** Keep in sync with migrations/0006_platform.sql (a test enforces this). */
export const PLATFORM_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS vector_sync_cursor (
  source TEXT PRIMARY KEY,
  mark TEXT NOT NULL DEFAULT '',
  last_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS brain_dump_chunks (
  chunk_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  synced_at TEXT NOT NULL
)`,
];

/** Tasks and the Brain Dump are company-wide, so they are indexed under this group id. */
export const COMPANY_WIDE_GROUP = "*";
export const VECTOR_SYNC_INTERVAL_MS = 10 * 60 * 1_000;
export const BRAIN_DUMP_SYNC_INTERVAL_MS = 60 * 60 * 1_000;
/** Shorter founder messages ("ok", "done 👍") carry no meaning worth indexing. */
export const MIN_MESSAGE_CHARACTERS = 20;
/** Large enough for years of notes; the model-facing read stays at 12k. */
const BRAIN_DUMP_INDEX_CHARACTERS = 400_000;
const BRAIN_DUMP_CHUNK_CHARACTERS = 1_200;
const MAX_ITEM_CHARACTERS = 4_000;
const ROWS_PER_INSERT = 15;
/** Appended by the Notion reader when it cuts a page short; not part of any note. */
const TRUNCATION_MARKER = "[Content truncated by Captain Patch]";

/** Row-backed sources, synced in this order. */
const ROW_SOURCES = ["memory", "memory_deleted", "task", "message"] as const;
export type RowSourceName = (typeof ROW_SOURCES)[number];

export interface VectorSyncCounts {
  memory: number;
  task: number;
  message: number;
  brainDump: number;
  /** Vectors removed for deleted memories and tasks and vanished Brain Dump notes. */
  removed: number;
}

interface Cursor {
  mark: string;
  lastId: number;
}

interface SourceBatch {
  rows: number;
  next: Cursor;
  upserts: SemanticItem[];
  removals: string[];
}

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
  updated_at: string;
  deleted_at: string | null;
}

interface MessageRow {
  id: number;
  group_id: string;
  author: string;
  body: string;
  sent_at_ms: number;
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

export function taskVectorItem(row: Pick<TaskRow, "id" | "title" | "notes" | "owner" | "area" | "tags">): SemanticItem {
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

export function messageVectorItem(row: MessageRow): SemanticItem {
  return {
    id: `message:${row.id}`,
    text: `${row.author}: ${row.body.slice(0, MAX_ITEM_CHARACTERS)}`,
    metadata: {
      group_id: row.group_id,
      kind: "message",
      ref: `message:${row.id}`,
      author: row.author.slice(0, 100),
      sent_at: new Date(Number(row.sent_at_ms)).toISOString(),
    },
  };
}

export interface BrainDumpChunk {
  /** `brain:<hash>` of heading and content, so an unchanged note keeps its id. */
  id: string;
  position: number;
  heading: string | null;
  content: string;
}

/**
 * Splits the Brain Dump into notes of about 1,200 characters, starting a new
 * one at every heading and carrying that heading along. Chunking from the top
 * is deterministic, so appending at the end leaves earlier ids unchanged.
 */
export function chunkBrainDump(markdown: string): BrainDumpChunk[] {
  const chunks: BrainDumpChunk[] = [];
  const seen = new Set<string>();
  let heading: string | null = null;
  let lines: string[] = [];
  let size = 0;
  const flush = () => {
    const content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_ITEM_CHARACTERS);
    lines = [];
    size = 0;
    if (content.length < 3) return;
    const id = `brain:${createHash("sha256").update(`${heading ?? ""}\n${content}`).digest("hex").slice(0, 32)}`;
    if (seen.has(id)) return;
    seen.add(id);
    chunks.push({ id, position: chunks.length, heading, content });
  };
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === TRUNCATION_MARKER) continue;
    const headingMatch = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (headingMatch?.[1]) {
      flush();
      heading = headingMatch[1].slice(0, 200);
      continue;
    }
    if (size > 0 && size + line.length > BRAIN_DUMP_CHUNK_CHARACTERS) flush();
    lines.push(line);
    size += line.length + 1;
  }
  flush();
  return chunks;
}

export function brainDumpVectorItem(chunk: BrainDumpChunk): SemanticItem {
  return {
    id: chunk.id,
    text: [chunk.heading ? `Brain Dump, ${chunk.heading}:` : "Brain Dump:", chunk.content].join("\n"),
    metadata: {
      group_id: COMPANY_WIDE_GROUP,
      kind: "brain_dump",
      ref: "Brain Dump",
      heading: (chunk.heading ?? "").slice(0, 120),
    },
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

interface VectorSyncOptions {
  db: SqlExecutor;
  index: Pick<SemanticIndex, "upsert" | "remove">;
  logger: Logger;
  /** The D1 conversation log's schema; given only when the conversation is stored in D1. */
  conversation?: SchemaGate;
  /** Reads the Notion Brain Dump; given only when it is configured. */
  brainDump?: { read: (options: { maxCharacters: number }) => Promise<BrainDumpResult> };
  intervalMs?: number;
  brainDumpIntervalMs?: number;
  /** Rows read and synced per round trip. */
  batchSize?: number;
  /** Caps one run so a large backfill spreads over several runs. */
  maxBatchesPerRun?: number;
  now?: () => Date;
}

/**
 * Silent background job that keeps Vectorize in step with D1 and the Brain Dump:
 * - memories: new ones are embedded once (by id); forgotten ones are removed;
 * - tasks: new, edited, deleted and restored tasks follow `updated_at`;
 * - founders' messages, when the conversation is stored in D1;
 * - Brain Dump notes, read about hourly, added and removed by content hash.
 * A cursor per source in D1 (`vector_sync_cursor`) advances only after the
 * index accepted the batch; vector ids are stable, so replays are harmless.
 * Search re-reads every match from D1, so a vector that outlives its row
 * (a pruned message) never surfaces.
 */
export class VectorSyncJob implements ScheduledJob {
  public readonly name = "vector sync";
  public readonly intervalMs: number;
  private readonly schema: SchemaGate;
  private lastBrainDumpMs = Number.NEGATIVE_INFINITY;

  public constructor(private readonly options: VectorSyncOptions) {
    this.intervalMs = options.intervalMs ?? VECTOR_SYNC_INTERVAL_MS;
    this.schema = new SchemaGate(options.db, PLATFORM_SCHEMA_STATEMENTS, options.logger, "Platform");
  }

  public async run(): Promise<void> {
    const synced = await this.syncAll();
    if (Object.values(synced).some((count) => count > 0)) {
      this.options.logger.info(synced, "Synced semantic memory");
    }
  }

  /** A failing source does not block the others; it resumes from its saved cursor. */
  public async syncAll(): Promise<VectorSyncCounts> {
    await this.schema.ensure();
    const counts: VectorSyncCounts = { memory: 0, task: 0, message: 0, brainDump: 0, removed: 0 };
    for (const source of ROW_SOURCES) {
      if (source === "message" && !this.options.conversation) continue;
      try {
        const { upserted, removed } = await this.syncSource(source);
        if (source !== "memory_deleted") counts[source] += upserted;
        counts.removed += removed;
      } catch (error) {
        this.options.logger.error({ error, source }, "Semantic sync failed; it will resume from the last saved cursor");
      }
    }
    if (this.options.brainDump) {
      try {
        const { upserted, removed } = await this.syncBrainDump();
        counts.brainDump = upserted;
        counts.removed += removed;
      } catch (error) {
        this.options.logger.error({ error }, "Brain Dump semantic sync failed; it will retry next hour");
      }
    }
    return counts;
  }

  public async cursor(source: RowSourceName): Promise<Cursor> {
    await this.schema.ensure();
    const result = await this.options.db.query<{ mark: string; last_id: number }>(
      "SELECT mark, last_id FROM vector_sync_cursor WHERE source = ?",
      [source],
    );
    const row = result.results[0];
    return { mark: row?.mark ?? "", lastId: Number(row?.last_id ?? 0) };
  }

  private async syncSource(source: RowSourceName): Promise<{ upserted: number; removed: number }> {
    const batchSize = this.options.batchSize ?? 100;
    const maxBatches = this.options.maxBatchesPerRun ?? 5;
    let upserted = 0;
    let removed = 0;
    for (let round = 0; round < maxBatches; round += 1) {
      const batch = await this.fetch(source, await this.cursor(source), batchSize);
      if (batch.rows === 0) break;
      if (batch.upserts.length > 0) await this.options.index.upsert(batch.upserts);
      if (batch.removals.length > 0) await this.options.index.remove(batch.removals);
      // Only after the index accepted the batch.
      await this.options.db.query(
        `INSERT INTO vector_sync_cursor (source, mark, last_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (source) DO UPDATE SET
           mark = excluded.mark, last_id = excluded.last_id, updated_at = excluded.updated_at`,
        [source, batch.next.mark, batch.next.lastId, this.nowIso()],
      );
      upserted += batch.upserts.length;
      removed += batch.removals.length;
      if (batch.rows < batchSize) break;
    }
    return { upserted, removed };
  }

  private async fetch(source: RowSourceName, cursor: Cursor, limit: number): Promise<SourceBatch> {
    switch (source) {
      case "memory": {
        // Memories are never edited, only forgotten, so an id cursor is enough.
        const { results } = await this.options.db.query<MemoryRow>(
          `SELECT id, group_id, kind, subject, content, source_author, observed_at FROM memories
           WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT ${limit}`,
          [cursor.lastId],
        );
        const last = results.at(-1);
        return {
          rows: results.length,
          next: { mark: "", lastId: last ? Number(last.id) : cursor.lastId },
          upserts: results.map(memoryVectorItem),
          removals: [],
        };
      }
      case "memory_deleted": {
        const { results } = await this.options.db.query<{ id: number; deleted_at: string }>(
          `SELECT id, deleted_at FROM memories
           WHERE deleted_at IS NOT NULL AND (deleted_at > ? OR (deleted_at = ? AND id > ?))
           ORDER BY deleted_at, id LIMIT ${limit}`,
          [cursor.mark, cursor.mark, cursor.lastId],
        );
        const last = results.at(-1);
        return {
          rows: results.length,
          next: last ? { mark: last.deleted_at, lastId: Number(last.id) } : cursor,
          upserts: [],
          removals: results.map((row) => `memory:${row.id}`),
        };
      }
      case "task": {
        // updated_at moves on every edit, delete and restore, so one cursor covers all three.
        const { results } = await this.options.db.query<TaskRow>(
          `SELECT id, title, notes, owner, area, tags, updated_at, deleted_at FROM tasks
           WHERE updated_at > ? OR (updated_at = ? AND id > ?)
           ORDER BY updated_at, id LIMIT ${limit}`,
          [cursor.mark, cursor.mark, cursor.lastId],
        );
        const last = results.at(-1);
        return {
          rows: results.length,
          next: last ? { mark: last.updated_at, lastId: Number(last.id) } : cursor,
          upserts: results.filter((row) => row.deleted_at === null).map(taskVectorItem),
          removals: results.filter((row) => row.deleted_at !== null).map((row) => `task:${row.id}`),
        };
      }
      case "message": {
        await this.options.conversation?.ensure();
        const { results } = await this.options.db.query<MessageRow & { from_bot: number }>(
          `SELECT id, group_id, author, body, from_bot, sent_at_ms FROM conversation_messages
           WHERE id > ? ORDER BY id LIMIT ${limit}`,
          [cursor.lastId],
        );
        const last = results.at(-1);
        return {
          rows: results.length,
          next: { mark: "", lastId: last ? Number(last.id) : cursor.lastId },
          upserts: results
            .filter((row) => Number(row.from_bot) === 0 && row.body.trim().length >= MIN_MESSAGE_CHARACTERS)
            .map(messageVectorItem),
          removals: [],
        };
      }
    }
  }

  /**
   * Reads the Brain Dump at most hourly, embeds notes not seen before and
   * removes notes that were edited or deleted in Notion. When the page was
   * cut short, nothing is removed, since the missing tail may still exist.
   */
  private async syncBrainDump(): Promise<{ upserted: number; removed: number }> {
    const reader = this.options.brainDump;
    const nowMs = (this.options.now?.() ?? new Date()).getTime();
    if (!reader || nowMs - this.lastBrainDumpMs < (this.options.brainDumpIntervalMs ?? BRAIN_DUMP_SYNC_INTERVAL_MS)) {
      return { upserted: 0, removed: 0 };
    }
    this.lastBrainDumpMs = nowMs;
    const dump = await reader.read({ maxCharacters: BRAIN_DUMP_INDEX_CHARACTERS });
    const chunks = chunkBrainDump(dump.markdown);
    const stored = await this.options.db.query<{ chunk_id: string }>("SELECT chunk_id FROM brain_dump_chunks");
    const known = new Set(stored.results.map((row) => row.chunk_id));

    const fresh = chunks.filter((chunk) => !known.has(chunk.id));
    if (fresh.length > 0) {
      await this.options.index.upsert(fresh.map(brainDumpVectorItem));
      for (let start = 0; start < fresh.length; start += ROWS_PER_INSERT) {
        const rows = fresh.slice(start, start + ROWS_PER_INSERT);
        const params: SqlValue[] = rows.flatMap((chunk) => [
          chunk.id,
          chunk.position,
          chunk.heading,
          chunk.content,
          this.nowIso(),
        ]);
        await this.options.db.query(
          `INSERT INTO brain_dump_chunks (chunk_id, position, heading, content, synced_at)
           VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}
           ON CONFLICT (chunk_id) DO NOTHING`,
          params,
        );
      }
    }

    const current = new Set(chunks.map((chunk) => chunk.id));
    const stale = dump.truncated ? [] : [...known].filter((id) => !current.has(id));
    if (stale.length > 0) {
      await this.options.index.remove(stale);
      for (let start = 0; start < stale.length; start += 50) {
        const ids = stale.slice(start, start + 50);
        await this.options.db.query(
          `DELETE FROM brain_dump_chunks WHERE chunk_id IN (${placeholders(ids.length)})`,
          ids,
        );
      }
    }
    return { upserted: fresh.length, removed: stale.length };
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
