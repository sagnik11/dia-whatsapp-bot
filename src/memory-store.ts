import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import { escapeLike, recordAudit, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";

export const MEMORY_KINDS = ["decision", "commitment", "fact", "person", "preference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryInput {
  kind: MemoryKind;
  subject: string;
  content: string;
  sourceAuthor: string | null;
  sourceMessageId: string | null;
  observedAt: string;
  /** A person's id (people.id) for a private memory; absent or 0 for one shared with the group. */
  ownerId?: number;
}

/** Who a memory search is for. */
export type MemoryViewer =
  /** The group's shared memory only: briefs, reviews and anything posted to the group. */
  | { scope: "shared" }
  /** Shared memory plus this person's own private memory, from any group. */
  | { scope: "person"; personId: number }
  /** Everything in the group, private included: only for deduplicating distilled memories. */
  | { scope: "all" };

export interface MemoryRecord {
  id: number;
  kind: MemoryKind;
  subject: string;
  content: string;
  sourceAuthor: string | null;
  sourceMessageId: string | null;
  observedAt: string;
  createdBy: string;
  /** 0 when shared with the group. */
  ownerId: number;
}

export interface MemoryQuery {
  text: string | null;
  kind: MemoryKind | null;
  sinceIso: string | null;
  limit: number;
  /** Defaults to the group's shared memory only. */
  viewer?: MemoryViewer;
}

function visibility(groupId: string, viewer: MemoryViewer = { scope: "shared" }): { sql: string; params: SqlValue[] } {
  switch (viewer.scope) {
    case "person":
      return { sql: "((group_id = ? AND owner_id = 0) OR owner_id = ?)", params: [groupId, viewer.personId] };
    case "all":
      return { sql: "group_id = ?", params: [groupId] };
    default:
      return { sql: "(group_id = ? AND owner_id = 0)", params: [groupId] };
  }
}

interface MemoryRow {
  id: number;
  kind: string;
  subject: string;
  content: string;
  source_author: string | null;
  source_message_id: string | null;
  observed_at: string;
  created_by: string;
  owner_id: number;
}

const COLUMNS =
  "id, kind, subject, content, source_author, source_message_id, observed_at, created_by, owner_id";

function rowToMemory(row: MemoryRow): MemoryRecord {
  return {
    id: Number(row.id),
    kind: row.kind as MemoryKind,
    subject: row.subject,
    content: row.content,
    sourceAuthor: row.source_author,
    sourceMessageId: row.source_message_id,
    observedAt: row.observed_at,
    createdBy: row.created_by,
    ownerId: Number(row.owner_id ?? 0),
  };
}

interface MemoryStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  logger: Logger;
  now?: () => Date;
}

/**
 * Long-term memory distilled from each group's conversation (and logged on
 * request). It outlives the raw conversation log. Shared memories belong to
 * one group; a private memory belongs to one person and only they see it.
 */
export class MemoryStore {
  public constructor(private readonly options: MemoryStoreOptions) {}

  public async add(
    groupId: string,
    entries: readonly MemoryInput[],
    createdBy: string,
  ): Promise<{ added: MemoryRecord[]; duplicates: number }> {
    await this.options.schema.ensure();
    const added: MemoryRecord[] = [];
    let duplicates = 0;
    for (const entry of entries) {
      const subject = entry.subject.trim().slice(0, 120);
      const content = entry.content.trim().slice(0, 1_000);
      if (!subject || !content) continue;
      const result = await this.options.db.query<MemoryRow>(
        `INSERT INTO memories (
           group_id, kind, subject, content, source_author, source_message_id,
           observed_at, created_by, created_at, owner_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_id, owner_id, kind, subject, content) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          groupId,
          entry.kind,
          subject,
          content,
          entry.sourceAuthor,
          entry.sourceMessageId,
          entry.observedAt,
          createdBy,
          this.nowIso(),
          Math.max(0, Math.trunc(entry.ownerId ?? 0)),
        ],
      );
      const row = result.results[0];
      if (!row) {
        duplicates += 1;
        continue;
      }
      const memory = rowToMemory(row);
      added.push(memory);
      await recordAudit(
        this.options.db,
        this.options.logger,
        { entity: "memory", entityId: memory.id, action: "created", actor: createdBy, changes: memory },
        this.nowIso(),
      );
    }
    return { added, duplicates };
  }

  /** Newest first. Text matches subject or content; several words must all match. */
  public async search(groupId: string, query: MemoryQuery): Promise<MemoryRecord[]> {
    await this.options.schema.ensure();
    const visible = visibility(groupId, query.viewer);
    const where = [visible.sql, "deleted_at IS NULL"];
    const params: SqlValue[] = [...visible.params];
    if (query.kind) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.sinceIso) {
      where.push("observed_at >= ?");
      params.push(query.sinceIso);
    }
    for (const word of (query.text ?? "").split(/\s+/).filter((w) => w.length > 1).slice(0, 5)) {
      where.push("(subject LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(word)}%`;
      params.push(pattern, pattern);
    }
    const limit = Math.max(1, Math.min(Math.trunc(query.limit), 200));
    const result = await this.options.db.query<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE ${where.join(" AND ")}
       ORDER BY observed_at DESC, id DESC LIMIT ${limit}`,
      params,
    );
    return result.results.map(rowToMemory);
  }

  /** Forgets a shared memory of this group, or one of the viewer's own private ones. */
  public async forget(
    groupId: string,
    id: number,
    actor: string,
    viewer: MemoryViewer = { scope: "shared" },
  ): Promise<MemoryRecord | null> {
    await this.options.schema.ensure();
    const visible = visibility(groupId, viewer.scope === "all" ? { scope: "shared" } : viewer);
    const existing = await this.options.db.query<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE id = ? AND ${visible.sql} AND deleted_at IS NULL`,
      [id, ...visible.params],
    );
    const row = existing.results[0];
    if (!row) return null;
    await this.options.db.query("UPDATE memories SET deleted_at = ? WHERE id = ?", [
      this.nowIso(),
      id,
    ]);
    const memory = rowToMemory(row);
    await recordAudit(
      this.options.db,
      this.options.logger,
      { entity: "memory", entityId: id, action: "deleted", actor, changes: memory },
      this.nowIso(),
    );
    return memory;
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
