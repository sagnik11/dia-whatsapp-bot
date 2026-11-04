import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import { escapeLike, recordAudit, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";
import { resolveDueTimestamp } from "./time.js";

export const FOLLOW_UP_STATUSES = ["open", "done", "dropped"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export interface FollowUpInput {
  owner: string;
  counterparty: string;
  promise: string;
  dueAt: string | null;
  notes: string | null;
}

export interface FollowUpRecord {
  id: number;
  owner: string;
  counterparty: string;
  promise: string;
  dueAt: string | null;
  status: FollowUpStatus;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
}

export interface FollowUpQuery {
  statuses: FollowUpStatus[] | null;
  owner: string | null;
  counterparty: string | null;
  dueTo: string | null;
  limit: number;
}

export interface FollowUpPatch {
  status: FollowUpStatus | null;
  dueAt: string | null;
  notes: string | null;
  promise: string | null;
}

interface FollowUpRow {
  id: number;
  owner: string;
  counterparty: string;
  promise: string;
  due_at: string | null;
  status: string;
  notes: string | null;
  created_by: string;
  created_at: string;
  closed_at: string | null;
}

const COLUMNS =
  "id, owner, counterparty, promise, due_at, status, notes, created_by, created_at, closed_at";

function rowToFollowUp(row: FollowUpRow): FollowUpRecord {
  return {
    id: Number(row.id),
    owner: row.owner,
    counterparty: row.counterparty,
    promise: row.promise,
    dueAt: row.due_at,
    status: row.status as FollowUpStatus,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

export class FollowUpValidationError extends Error {}

interface FollowUpStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  timezone: string;
  logger: Logger;
  now?: () => Date;
}

/** Promises the founders made to people outside the group, and what is owed back. */
export class FollowUpStore {
  public constructor(private readonly options: FollowUpStoreOptions) {}

  public async create(
    inputs: readonly FollowUpInput[],
    source: { actor: string; groupName: string | null; messageId: string | null },
  ): Promise<Array<{ followUp: FollowUpRecord; duplicate: boolean }>> {
    await this.options.schema.ensure();
    const results: Array<{ followUp: FollowUpRecord; duplicate: boolean }> = [];
    for (const input of inputs) {
      const promise = input.promise.trim().slice(0, 300);
      if (!promise) throw new FollowUpValidationError("Every follow-up needs a promise");
      const dueTs = this.dueTimestamp(input.dueAt);
      const now = this.nowIso();
      const inserted = await this.options.db.query<FollowUpRow>(
        `INSERT INTO follow_ups (
           owner, counterparty, promise, due_at, due_ts, notes, created_by,
           source_group, source_message_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_message_id, promise) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          input.owner.trim().slice(0, 100) || source.actor,
          input.counterparty.trim().slice(0, 100),
          promise,
          input.dueAt?.trim() || null,
          dueTs,
          input.notes?.trim().slice(0, 2_000) || null,
          source.actor,
          source.groupName,
          source.messageId,
          now,
          now,
        ],
      );
      const row = inserted.results[0];
      if (row) {
        const followUp = rowToFollowUp(row);
        await this.audit(followUp.id, "created", source.actor, followUp);
        results.push({ followUp, duplicate: false });
        continue;
      }
      const existing = await this.options.db.query<FollowUpRow>(
        `SELECT ${COLUMNS} FROM follow_ups WHERE source_message_id = ? AND promise = ?`,
        [source.messageId, promise],
      );
      const found = existing.results[0];
      if (!found) throw new Error(`Follow-up "${promise}" could not be persisted`);
      results.push({ followUp: rowToFollowUp(found), duplicate: true });
    }
    return results;
  }

  public async list(query: FollowUpQuery): Promise<FollowUpRecord[]> {
    await this.options.schema.ensure();
    const where: string[] = [];
    const params: SqlValue[] = [];
    const statuses = query.statuses?.length ? query.statuses : ["open"];
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
    if (query.owner?.trim()) {
      where.push("lower(owner) = lower(?)");
      params.push(query.owner.trim());
    }
    if (query.counterparty?.trim()) {
      where.push("counterparty LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(query.counterparty.trim())}%`);
    }
    if (query.dueTo) {
      const to = resolveDueTimestamp(query.dueTo, this.options.timezone, "end");
      if (to === null) throw new FollowUpValidationError("due_to is not a valid date");
      where.push("due_ts <= ?");
      params.push(to);
    }
    const limit = Math.max(1, Math.min(Math.trunc(query.limit), 100));
    const result = await this.options.db.query<FollowUpRow>(
      `SELECT ${COLUMNS} FROM follow_ups WHERE ${where.join(" AND ")}
       ORDER BY CASE WHEN due_ts IS NULL THEN 1 ELSE 0 END, due_ts ASC, id ASC
       LIMIT ${limit}`,
      params,
    );
    return result.results.map(rowToFollowUp);
  }

  public async update(id: number, patch: FollowUpPatch, actor: string): Promise<FollowUpRecord | null> {
    await this.options.schema.ensure();
    const current = await this.options.db.query<FollowUpRow>(
      `SELECT ${COLUMNS} FROM follow_ups WHERE id = ?`,
      [id],
    );
    const before = current.results[0] ? rowToFollowUp(current.results[0]) : null;
    if (!before) return null;

    const assignments: string[] = [];
    const params: SqlValue[] = [];
    if (patch.status && patch.status !== before.status) {
      assignments.push("status = ?", "closed_at = ?");
      params.push(patch.status, patch.status === "open" ? null : this.nowIso());
    }
    if (patch.dueAt?.trim() && patch.dueAt.trim() !== before.dueAt) {
      assignments.push("due_at = ?", "due_ts = ?");
      params.push(patch.dueAt.trim(), this.dueTimestamp(patch.dueAt));
    }
    if (patch.promise?.trim() && patch.promise.trim() !== before.promise) {
      assignments.push("promise = ?");
      params.push(patch.promise.trim().slice(0, 300));
    }
    if (patch.notes?.trim()) {
      assignments.push("notes = ?");
      params.push(before.notes ? `${before.notes}\n\n${patch.notes.trim()}` : patch.notes.trim());
    }
    if (assignments.length === 0) return before;

    const updated = await this.options.db.query<FollowUpRow>(
      `UPDATE follow_ups SET ${assignments.join(", ")}, updated_at = ? WHERE id = ? RETURNING ${COLUMNS}`,
      [...params, this.nowIso(), id],
    );
    const row = updated.results[0];
    if (!row) return null;
    const after = rowToFollowUp(row);
    await this.audit(id, "updated", actor, { before, after });
    return after;
  }

  private dueTimestamp(dueAt: string | null): number | null {
    const trimmed = dueAt?.trim();
    if (!trimmed) return null;
    const timestamp = resolveDueTimestamp(trimmed, this.options.timezone);
    if (timestamp === null) {
      throw new FollowUpValidationError(`"${trimmed}" is not a valid due date`);
    }
    return timestamp;
  }

  private audit(id: number, action: string, actor: string, changes: unknown): Promise<void> {
    return recordAudit(
      this.options.db,
      this.options.logger,
      { entity: "follow_up", entityId: id, action, actor, changes },
      this.nowIso(),
    );
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
