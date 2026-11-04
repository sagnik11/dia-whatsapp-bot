import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import { escapeLike, recordAudit, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";
import { isLocalDate, localDate } from "./recurring-store.js";

/** How one pipeline table (deals or candidates) names its columns and stages. */
export interface BoardSpec {
  table: string;
  entity: string;
  titleColumn: string;
  detailColumn: string;
  nextColumn: string;
  nextAtColumn: string;
  stages: readonly string[];
  closedStages: readonly string[];
  hasValue: boolean;
  /** Candidates are duplicates only for the same role; deals for the same company. */
  dedupeOnDetail: boolean;
}

export interface BoardRecord {
  id: number;
  title: string;
  detail: string | null;
  stage: string;
  valueInr: number | null;
  next: string | null;
  nextAt: string | null;
  owner: string | null;
  notes: string | null;
  stageChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardInput {
  title: string;
  detail: string | null;
  stage: string | null;
  valueInr: number | null;
  next: string | null;
  nextAt: string | null;
  owner: string | null;
  notes: string | null;
}

export const BOARD_CLEARABLE = ["detail", "valueInr", "next", "nextAt", "owner"] as const;
export type BoardClearable = (typeof BOARD_CLEARABLE)[number];

/** Null leaves a field unchanged; notes are appended. */
export interface BoardPatch extends Omit<BoardInput, "title"> {
  title: string | null;
  clear: BoardClearable[];
}

export interface BoardQuery {
  stages: string[] | null;
  owner: string | null;
  text: string | null;
  limit: number;
}

export interface BoardFlags {
  daysInStage: number;
  stuck: boolean;
  noNextStep: boolean;
  nextStepOverdue: boolean;
}

interface BoardRow {
  id: number;
  title: string;
  detail: string | null;
  stage: string;
  value_inr: number | null;
  next: string | null;
  next_at: string | null;
  owner: string | null;
  notes: string | null;
  stage_changed_at: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: BoardRow): BoardRecord {
  return {
    id: Number(row.id),
    title: row.title,
    detail: row.detail,
    stage: row.stage,
    valueInr: row.value_inr === null ? null : Number(row.value_inr),
    next: row.next,
    nextAt: row.next_at,
    owner: row.owner,
    notes: row.notes,
    stageChangedAt: row.stage_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Open items stuck in one stage, with no next step, or whose next step date has passed. */
export function boardFlags(
  record: BoardRecord,
  spec: Pick<BoardSpec, "closedStages">,
  nowMs: number,
  today: string,
  staleDays: number,
): BoardFlags {
  const open = !spec.closedStages.includes(record.stage);
  const daysInStage = Math.max(0, Math.floor((nowMs - Date.parse(record.stageChangedAt)) / DAY_MS));
  return {
    daysInStage,
    stuck: open && daysInStage >= staleDays,
    noNextStep: open && !record.next,
    nextStepOverdue: open && record.nextAt !== null && record.nextAt < today,
  };
}

export class BoardValidationError extends Error {}

export interface BoardStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  timezone: string;
  logger: Logger;
  now?: () => Date;
}

/** A staged pipeline in D1 with next steps, soft delete and an audit trail. */
export class BoardStore {
  private readonly columns: string;

  public constructor(
    public readonly spec: BoardSpec,
    private readonly options: BoardStoreOptions,
  ) {
    this.columns = [
      "id",
      `${spec.titleColumn} AS title`,
      `${spec.detailColumn} AS detail`,
      "stage",
      `${spec.hasValue ? "value_inr" : "NULL"} AS value_inr`,
      `${spec.nextColumn} AS next`,
      `${spec.nextAtColumn} AS next_at`,
      "owner, notes, stage_changed_at, created_at, updated_at",
    ].join(", ");
  }

  public nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  public today(): string {
    return localDate(this.nowMs(), this.options.timezone);
  }

  public async create(
    inputs: readonly BoardInput[],
    actor: string,
  ): Promise<Array<{ record: BoardRecord; duplicate: boolean }>> {
    await this.options.schema.ensure();
    const { spec } = this;
    const results: Array<{ record: BoardRecord; duplicate: boolean }> = [];
    for (const input of inputs) {
      const title = input.title.trim().slice(0, 120);
      if (!title) throw new BoardValidationError(`Every ${spec.entity} needs a ${spec.titleColumn}`);
      const stage = input.stage ?? spec.stages[0] ?? "";
      this.validate(stage, input.nextAt);
      const detail = input.detail?.trim().slice(0, 120) || null;
      const duplicate = await this.findOpen(title, spec.dedupeOnDetail ? detail : undefined);
      if (duplicate) {
        results.push({ record: duplicate, duplicate: true });
        continue;
      }
      const now = this.nowIso();
      const columns = [spec.titleColumn, spec.detailColumn, "stage", spec.nextColumn, spec.nextAtColumn, "owner", "notes"];
      const values: SqlValue[] = [
        title,
        detail,
        stage,
        input.next?.trim().slice(0, 300) || null,
        input.nextAt,
        input.owner?.trim().slice(0, 100) || null,
        input.notes?.trim().slice(0, 2_000) || null,
      ];
      if (spec.hasValue) {
        columns.push("value_inr");
        values.push(input.valueInr);
      }
      columns.push("stage_changed_at", "created_by", "updated_by", "created_at", "updated_at");
      values.push(now, actor, actor, now, now);
      const inserted = await this.options.db.query<BoardRow>(
        `INSERT INTO ${spec.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
         RETURNING ${this.columns}`,
        values,
      );
      if (!inserted.results[0]) throw new Error(`${spec.entity} "${title}" could not be persisted`);
      const record = rowToRecord(inserted.results[0]);
      await this.audit(record.id, "created", actor, record);
      results.push({ record, duplicate: false });
    }
    return results;
  }

  public async get(id: number): Promise<BoardRecord | null> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<BoardRow>(
      `SELECT ${this.columns} FROM ${this.spec.table} WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return result.results[0] ? rowToRecord(result.results[0]) : null;
  }

  /** By stage order, then soonest next step. */
  public async list(query: BoardQuery): Promise<BoardRecord[]> {
    await this.options.schema.ensure();
    const { spec } = this;
    const where = ["deleted_at IS NULL"];
    const params: SqlValue[] = [];
    if (query.stages?.length) {
      where.push(`stage IN (${query.stages.map(() => "?").join(", ")})`);
      params.push(...query.stages);
    }
    if (query.owner?.trim()) {
      where.push("lower(owner) = lower(?)");
      params.push(query.owner.trim());
    }
    if (query.text?.trim()) {
      const pattern = `%${escapeLike(query.text.trim())}%`;
      where.push(`(${spec.titleColumn} LIKE ? ESCAPE '\\' OR ${spec.detailColumn} LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern);
    }
    const order = `CASE stage ${spec.stages.map((stage, index) => `WHEN '${stage}' THEN ${index}`).join(" ")} END`;
    const limit = Math.max(1, Math.min(Math.trunc(query.limit), 100));
    const result = await this.options.db.query<BoardRow>(
      `SELECT ${this.columns} FROM ${spec.table} WHERE ${where.join(" AND ")}
       ORDER BY ${order}, CASE WHEN ${spec.nextAtColumn} IS NULL THEN 1 ELSE 0 END, ${spec.nextAtColumn}, id
       LIMIT ${limit}`,
      params,
    );
    return result.results.map(rowToRecord);
  }

  public async update(
    id: number,
    patch: BoardPatch,
    actor: string,
  ): Promise<{ before: BoardRecord; after: BoardRecord; changed: string[] } | null> {
    const before = await this.get(id);
    if (!before) return null;
    const { spec } = this;
    if (patch.stage) this.validate(patch.stage, patch.nextAt);
    else this.validate(before.stage, patch.nextAt);
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    const changed: string[] = [];
    const set = (column: string, value: SqlValue, field: string) => {
      assignments.push(`${column} = ?`);
      params.push(value);
      changed.push(field);
    };
    const clear = new Set(patch.clear);
    const text = (value: string | null, max: number) => value?.trim().slice(0, max) || null;
    const title = text(patch.title, 120);
    if (title && title !== before.title) set(spec.titleColumn, title, spec.titleColumn);
    const fields: Array<[BoardClearable, string, SqlValue, SqlValue]> = [
      ["detail", spec.detailColumn, text(patch.detail, 120), before.detail],
      ["next", spec.nextColumn, text(patch.next, 300), before.next],
      ["nextAt", spec.nextAtColumn, patch.nextAt, before.nextAt],
      ["owner", "owner", text(patch.owner, 100), before.owner],
      ...(spec.hasValue ? [["valueInr", "value_inr", patch.valueInr, before.valueInr] as [BoardClearable, string, SqlValue, SqlValue]] : []),
    ];
    for (const [field, column, value, current] of fields) {
      if (clear.has(field) && value === null) {
        if (current !== null) set(column, null, column);
      } else if (value !== null && value !== current) {
        set(column, value, column);
      }
    }
    if (patch.stage && patch.stage !== before.stage) {
      set("stage", patch.stage, "stage");
      set("stage_changed_at", this.nowIso(), "stage");
    }
    const notes = patch.notes?.trim();
    if (notes) set("notes", (before.notes ? `${before.notes}\n\n${notes}` : notes).slice(0, 4_000), "notes");
    if (assignments.length === 0) return { before, after: before, changed: [] };
    const now = this.nowIso();
    const updated = await this.options.db.query<BoardRow>(
      `UPDATE ${spec.table} SET ${assignments.join(", ")}, updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL RETURNING ${this.columns}`,
      [...params, actor, now, id],
    );
    if (!updated.results[0]) return null;
    const after = rowToRecord(updated.results[0]);
    const unique = [...new Set(changed)];
    await this.audit(id, "updated", actor, { before, after, changed: unique });
    return { before, after, changed: unique };
  }

  /** Soft delete: gone from every list, kept in D1 for audit. */
  public async remove(id: number, actor: string): Promise<BoardRecord | null> {
    const before = await this.get(id);
    if (!before) return null;
    const now = this.nowIso();
    await this.options.db.query(
      `UPDATE ${this.spec.table} SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL`,
      [now, now, actor, id],
    );
    await this.audit(id, "deleted", actor, before);
    return before;
  }

  /** Items that entered one of these stages in [fromIso, toIso). */
  public async movedInto(stages: readonly string[], fromIso: string, toIso: string): Promise<BoardRecord[]> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<BoardRow>(
      `SELECT ${this.columns} FROM ${this.spec.table}
       WHERE deleted_at IS NULL AND stage IN (${stages.map(() => "?").join(", ")})
         AND stage_changed_at >= ? AND stage_changed_at < ?
       ORDER BY stage_changed_at ASC, id ASC LIMIT 100`,
      [...stages, fromIso, toIso],
    );
    return result.results.map(rowToRecord);
  }

  private async findOpen(title: string, detail: string | null | undefined): Promise<BoardRecord | null> {
    const { spec } = this;
    const closed = spec.closedStages.map(() => "?").join(", ");
    const params: SqlValue[] = [title, ...spec.closedStages];
    let detailClause = "";
    if (detail !== undefined) {
      detailClause = `AND lower(coalesce(${spec.detailColumn}, '')) = lower(?)`;
      params.push(detail ?? "");
    }
    const result = await this.options.db.query<BoardRow>(
      `SELECT ${this.columns} FROM ${spec.table}
       WHERE deleted_at IS NULL AND lower(${spec.titleColumn}) = lower(?) AND stage NOT IN (${closed}) ${detailClause}
       ORDER BY id ASC LIMIT 1`,
      params,
    );
    return result.results[0] ? rowToRecord(result.results[0]) : null;
  }

  private validate(stage: string, nextAt: string | null): void {
    if (!this.spec.stages.includes(stage)) {
      throw new BoardValidationError(`stage must be one of ${this.spec.stages.join(", ")}`);
    }
    if (nextAt !== null && !isLocalDate(nextAt)) {
      throw new BoardValidationError(`${this.spec.nextAtColumn} "${nextAt}" is not a YYYY-MM-DD date`);
    }
  }

  private audit(id: number, action: string, actor: string, changes: unknown): Promise<void> {
    return recordAudit(
      this.options.db,
      this.options.logger,
      { entity: this.spec.entity, entityId: id, action, actor, changes },
      this.nowIso(),
    );
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
}
