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
}

export interface MemoryRecord {
  id: number;
  kind: MemoryKind;
  subject: string;
  content: string;
  sourceAuthor: string | null;
  sourceMessageId: string | null;
  observedAt: string;
  createdBy: string;
}

export interface MemoryQuery {
  text: string | null;
  kind: MemoryKind | null;
  sinceIso: string | null;
  limit: number;
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
}

const COLUMNS =
  "id, kind, subject, content, source_author, source_message_id, observed_at, created_by";

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
 * request). It outlives the raw conversation log and never crosses groups.
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
           observed_at, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_id, kind, subject, content) DO NOTHING
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
    const where = ["group_id = ?", "deleted_at IS NULL"];
    const params: SqlValue[] = [groupId];
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

  public async forget(groupId: string, id: number, actor: string): Promise<MemoryRecord | null> {
    await this.options.schema.ensure();
    const existing = await this.options.db.query<MemoryRow>(
      `SELECT ${COLUMNS} FROM memories WHERE id = ? AND group_id = ? AND deleted_at IS NULL`,
      [id, groupId],
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
