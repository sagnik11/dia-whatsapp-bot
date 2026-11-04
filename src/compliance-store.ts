import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import { recordAudit, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";
import { addDays, isLocalDate, localDate } from "./recurring-store.js";
import type { TaskStore } from "./task-store.js";
import type { ScheduledJob } from "./tool-module.js";

export const COMPLIANCE_RECURRENCES = ["none", "monthly", "quarterly", "yearly"] as const;
export const COMPLIANCE_AREAS = ["Legal", "Finance"] as const;
export const COMPLIANCE_STATUSES = ["active", "archived"] as const;
export type ComplianceRecurrence = (typeof COMPLIANCE_RECURRENCES)[number];
export type ComplianceArea = (typeof COMPLIANCE_AREAS)[number];
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export interface ComplianceInput {
  name: string;
  authority: string | null;
  area: ComplianceArea | null;
  dueOn: string;
  recurrence: ComplianceRecurrence;
  owner: string | null;
  leadDays: number | null;
  checklist: string | null;
  notes: string | null;
}

export interface ComplianceRecord {
  id: number;
  name: string;
  authority: string | null;
  area: ComplianceArea;
  dueOn: string;
  /** Day of the month recurring periods are anchored to. */
  dueDay: number;
  recurrence: ComplianceRecurrence;
  owner: string | null;
  leadDays: number;
  checklist: string | null;
  notes: string | null;
  status: ComplianceStatus;
  /** The task the silent job added, and the due date it was added for. */
  taskId: number | null;
  taskDueOn: string | null;
  lastDoneOn: string | null;
  updatedAt: string;
}

/** Null leaves a field unchanged; notes are appended. */
export interface CompliancePatch {
  name: string | null;
  authority: string | null;
  area: ComplianceArea | null;
  dueOn: string | null;
  recurrence: ComplianceRecurrence | null;
  owner: string | null;
  leadDays: number | null;
  checklist: string | null;
  notes: string | null;
  status: ComplianceStatus | null;
}

export interface ComplianceQuery {
  statuses: ComplianceStatus[];
  dueFrom: string | null;
  dueTo: string | null;
  owner: string | null;
  limit: number;
}

interface ComplianceRow {
  id: number;
  name: string;
  authority: string | null;
  area: string;
  due_on: string;
  due_day: number;
  recurrence: string;
  owner: string | null;
  lead_days: number;
  checklist: string | null;
  notes: string | null;
  status: string;
  task_id: number | null;
  task_due_on: string | null;
  last_done_on: string | null;
  updated_at: string;
}

const COLUMNS =
  "id, name, authority, area, due_on, due_day, recurrence, owner, lead_days, checklist, notes, status, task_id, task_due_on, last_done_on, updated_at";

function rowToItem(row: ComplianceRow): ComplianceRecord {
  return {
    id: Number(row.id),
    name: row.name,
    authority: row.authority,
    area: row.area as ComplianceArea,
    dueOn: row.due_on,
    dueDay: Number(row.due_day),
    recurrence: row.recurrence as ComplianceRecurrence,
    owner: row.owner,
    leadDays: Number(row.lead_days),
    checklist: row.checklist,
    notes: row.notes,
    status: row.status as ComplianceStatus,
    taskId: row.task_id === null ? null : Number(row.task_id),
    taskDueOn: row.task_due_on,
    lastDoneOn: row.last_done_on,
    updatedAt: row.updated_at,
  };
}

// --- Date math -----------------------------------------------------------------

const MONTHS: Readonly<Record<Exclude<ComplianceRecurrence, "none">, number>> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

function dayOf(date: string): number {
  return Number(date.slice(8, 10));
}

/**
 * The next period's due date, anchored to the original day of the month so a
 * 31st deadline goes 31 Jan → 28 Feb → 31 Mar instead of drifting to the 28th.
 */
export function nextDueOn(dueOn: string, recurrence: ComplianceRecurrence, dueDay = dayOf(dueOn)): string | null {
  if (recurrence === "none") return null;
  const year = Number(dueOn.slice(0, 4));
  const total = Number(dueOn.slice(5, 7)) - 1 + MONTHS[recurrence];
  const nextYear = year + Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return new Date(Date.UTC(nextYear, nextMonth - 1, Math.min(dueDay, lastDay))).toISOString().slice(0, 10);
}

/** The local date on which the silent job adds the item's task. */
export function taskWindowOpensOn(item: Pick<ComplianceRecord, "dueOn" | "leadDays">): string {
  return addDays(item.dueOn, -item.leadDays);
}

/** Finance for tax and payroll filings, Legal for everything else, unless the founders say otherwise. */
export function inferComplianceArea(name: string, authority: string | null): ComplianceArea {
  return /\b(?:gst\w*|tds|tcs|income[\s-]?tax|advance\s+tax|itr|e?pfo?|esic?|professional\s+tax|tax|audit|accounts?|cbdt|cbic|payroll)\b/i.test(
    `${name} ${authority ?? ""}`,
  )
    ? "Finance"
    : "Legal";
}

export function complianceTaskSourceId(item: Pick<ComplianceRecord, "id" | "dueOn">): string {
  return `compliance:${item.id}:${item.dueOn}`;
}

// --- Store ----------------------------------------------------------------------

export class ComplianceValidationError extends Error {}

interface ComplianceStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  timezone: string;
  logger: Logger;
  /** Lead days for items added without one. */
  defaultLeadDays?: number;
  now?: () => Date;
}

/** Filings and renewals the founders or their CA gave Patch. It never adds obligations itself. */
export class ComplianceStore {
  public constructor(private readonly options: ComplianceStoreOptions) {}

  public today(): string {
    return localDate(this.nowMs(), this.options.timezone);
  }

  public async add(
    inputs: readonly ComplianceInput[],
    actor: string,
  ): Promise<Array<{ item: ComplianceRecord; duplicate: boolean }>> {
    await this.options.schema.ensure();
    const results: Array<{ item: ComplianceRecord; duplicate: boolean }> = [];
    for (const input of inputs) {
      const name = input.name.trim().slice(0, 200);
      if (!name) throw new ComplianceValidationError("Every compliance item needs a name");
      if (!isLocalDate(input.dueOn)) {
        throw new ComplianceValidationError(`due_on "${input.dueOn}" for "${name}" is not a YYYY-MM-DD date`);
      }
      const existing = await this.options.db.query<ComplianceRow>(
        `SELECT ${COLUMNS} FROM compliance_items
         WHERE deleted_at IS NULL AND status = 'active' AND lower(name) = lower(?) LIMIT 1`,
        [name],
      );
      if (existing.results[0]) {
        results.push({ item: rowToItem(existing.results[0]), duplicate: true });
        continue;
      }
      const authority = input.authority?.trim().slice(0, 100) || null;
      const now = this.nowIso();
      const inserted = await this.options.db.query<ComplianceRow>(
        `INSERT INTO compliance_items (
           name, authority, area, due_on, due_day, recurrence, owner, lead_days,
           checklist, notes, created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${COLUMNS}`,
        [
          name,
          authority,
          input.area ?? inferComplianceArea(name, authority),
          input.dueOn,
          dayOf(input.dueOn),
          input.recurrence,
          input.owner?.trim().slice(0, 100) || null,
          input.leadDays ?? this.options.defaultLeadDays ?? 14,
          input.checklist?.trim().slice(0, 4_000) || null,
          input.notes?.trim().slice(0, 2_000) || null,
          actor,
          actor,
          now,
          now,
        ],
      );
      const row = inserted.results[0];
      if (!row) throw new Error(`Compliance item "${name}" could not be persisted`);
      const item = rowToItem(row);
      await this.audit(item.id, "created", actor, item);
      results.push({ item, duplicate: false });
    }
    return results;
  }

  public async get(id: number): Promise<ComplianceRecord | null> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<ComplianceRow>(
      `SELECT ${COLUMNS} FROM compliance_items WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return result.results[0] ? rowToItem(result.results[0]) : null;
  }

  /** Soonest due first. */
  public async list(query: ComplianceQuery): Promise<ComplianceRecord[]> {
    await this.options.schema.ensure();
    const statuses = query.statuses.length > 0 ? query.statuses : ["active"];
    const where = ["deleted_at IS NULL", `status IN (${statuses.map(() => "?").join(", ")})`];
    const params: SqlValue[] = [...statuses];
    if (query.dueFrom) {
      where.push("due_on >= ?");
      params.push(query.dueFrom);
    }
    if (query.dueTo) {
      where.push("due_on <= ?");
      params.push(query.dueTo);
    }
    if (query.owner?.trim()) {
      where.push("lower(owner) = lower(?)");
      params.push(query.owner.trim());
    }
    const limit = Math.max(1, Math.min(Math.trunc(query.limit), 100));
    const result = await this.options.db.query<ComplianceRow>(
      `SELECT ${COLUMNS} FROM compliance_items WHERE ${where.join(" AND ")}
       ORDER BY due_on ASC, id ASC LIMIT ${limit}`,
      params,
    );
    return result.results.map(rowToItem);
  }

  public async update(
    id: number,
    patch: CompliancePatch,
    actor: string,
  ): Promise<{ before: ComplianceRecord; after: ComplianceRecord } | null> {
    const before = await this.get(id);
    if (!before) return null;
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    const set = (column: string, value: SqlValue) => {
      assignments.push(`${column} = ?`);
      params.push(value);
    };
    const name = patch.name?.trim().slice(0, 200);
    if (name && name !== before.name) set("name", name);
    const authority = patch.authority?.trim().slice(0, 100);
    if (authority && authority !== before.authority) set("authority", authority);
    if (patch.area && patch.area !== before.area) set("area", patch.area);
    if (patch.dueOn && patch.dueOn !== before.dueOn) {
      if (!isLocalDate(patch.dueOn)) {
        throw new ComplianceValidationError(`due_on "${patch.dueOn}" is not a YYYY-MM-DD date`);
      }
      set("due_on", patch.dueOn);
      set("due_day", dayOf(patch.dueOn));
    }
    if (patch.recurrence && patch.recurrence !== before.recurrence) set("recurrence", patch.recurrence);
    const owner = patch.owner?.trim().slice(0, 100);
    if (owner && owner !== before.owner) set("owner", owner);
    if (patch.leadDays !== null && patch.leadDays !== before.leadDays) set("lead_days", patch.leadDays);
    const checklist = patch.checklist?.trim().slice(0, 4_000);
    if (checklist && checklist !== before.checklist) set("checklist", checklist);
    const notes = patch.notes?.trim();
    if (notes) set("notes", (before.notes ? `${before.notes}\n\n${notes}` : notes).slice(0, 4_000));
    if (patch.status && patch.status !== before.status) set("status", patch.status);
    if (assignments.length === 0) return { before, after: before };
    return this.write(before, assignments, params, actor, "updated");
  }

  /**
   * Record this period as filed: a recurring item rolls forward one period, a
   * one-off is archived. Only the period that was current when read is moved,
   * so a repeated call cannot skip a period.
   */
  public async markDone(
    id: number,
    actor: string,
  ): Promise<{ before: ComplianceRecord; after: ComplianceRecord } | null> {
    const before = await this.get(id);
    if (!before) return null;
    const today = this.today();
    const next = nextDueOn(before.dueOn, before.recurrence, before.dueDay);
    const assignments = next ? ["due_on = ?", "last_done_on = ?"] : ["status = 'archived'", "last_done_on = ?"];
    const params: SqlValue[] = next ? [next, today] : [today];
    return this.write(before, assignments, params, actor, "done", "AND due_on = ?", [before.dueOn]);
  }

  public async remove(id: number, actor: string): Promise<ComplianceRecord | null> {
    const before = await this.get(id);
    if (!before) return null;
    const now = this.nowIso();
    await this.options.db.query(
      "UPDATE compliance_items SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL",
      [now, now, actor, id],
    );
    await this.audit(id, "deleted", actor, before);
    return before;
  }

  /** Active items whose task window has opened and that have no task for their current due date yet. */
  public async needingTasks(today: string): Promise<ComplianceRecord[]> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<ComplianceRow>(
      `SELECT ${COLUMNS} FROM compliance_items
       WHERE deleted_at IS NULL AND status = 'active'
         AND (task_due_on IS NULL OR task_due_on <> due_on)
       ORDER BY due_on ASC, id ASC LIMIT 200`,
    );
    return result.results.map(rowToItem).filter((item) => taskWindowOpensOn(item) <= today);
  }

  /** Remember which task covers the item's current due date, so the job adds it only once. */
  public async markTaskCreated(item: Pick<ComplianceRecord, "id" | "dueOn">, taskId: number): Promise<void> {
    await this.options.db.query(
      "UPDATE compliance_items SET task_id = ?, task_due_on = ? WHERE id = ? AND due_on = ?",
      [taskId, item.dueOn, item.id, item.dueOn],
    );
  }

  private async write(
    before: ComplianceRecord,
    assignments: string[],
    params: SqlValue[],
    actor: string,
    action: string,
    guard = "",
    guardParams: SqlValue[] = [],
  ): Promise<{ before: ComplianceRecord; after: ComplianceRecord } | null> {
    const now = this.nowIso();
    const updated = await this.options.db.query<ComplianceRow>(
      `UPDATE compliance_items SET ${assignments.join(", ")}, updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL ${guard}
       RETURNING ${COLUMNS}`,
      [...params, actor, now, before.id, ...guardParams],
    );
    const row = updated.results[0];
    if (!row) return null;
    const after = rowToItem(row);
    await this.audit(before.id, action, actor, { before, after });
    return { before, after };
  }

  private audit(id: number, action: string, actor: string, changes: unknown): Promise<void> {
    return recordAudit(
      this.options.db,
      this.options.logger,
      { entity: "compliance_item", entityId: id, action, actor, changes },
      this.nowIso(),
    );
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
}

// --- Silent job -------------------------------------------------------------------

/** Add a normal task for every item whose window opened. Never posts to the group. */
export async function materializeComplianceTasks(input: {
  compliance: Pick<ComplianceStore, "needingTasks" | "markTaskCreated">;
  tasks: Pick<TaskStore, "create">;
  timezone: string;
  nowMs: number;
  logger: Logger;
}): Promise<number> {
  const today = localDate(input.nowMs, input.timezone);
  let created = 0;
  for (const item of await input.compliance.needingTasks(today)) {
    try {
      const notes = [
        `From the compliance register (CO${item.id}${item.authority ? `, ${item.authority}` : ""}).`,
        item.checklist ? `Checklist:\n${item.checklist}` : null,
        item.notes,
        `When it is filed, tell Patch "CO${item.id} done" to roll the register forward.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const [result] = await input.tasks.create(
        [
          {
            title: item.name,
            notes,
            status: null,
            priority: null,
            owner: item.owner,
            area: item.area,
            dueAt: item.dueOn,
            tags: ["compliance"],
          },
        ],
        // The due date in the source id makes a retried run a no-op for this period.
        { actor: "Patch (compliance)", groupName: null, messageId: complianceTaskSourceId(item) },
      );
      if (!result) continue;
      if (!result.duplicate) created += 1;
      await input.compliance.markTaskCreated(item, result.task.id);
    } catch (error) {
      input.logger.error({ error, complianceId: item.id }, "Could not add a compliance task; will retry");
    }
  }
  return created;
}

const HOUR_MS = 60 * 60 * 1_000;

export function createComplianceJob(input: {
  compliance: Pick<ComplianceStore, "needingTasks" | "markTaskCreated">;
  tasks: Pick<TaskStore, "create">;
  timezone: string;
  logger: Logger;
  intervalMs?: number;
}): ScheduledJob {
  return {
    name: "compliance tasks",
    intervalMs: input.intervalMs ?? HOUR_MS,
    // The send function is deliberately unused: compliance work is silent.
    run: async (nowMs) => {
      const created = await materializeComplianceTasks({ ...input, nowMs });
      if (created > 0) input.logger.info({ created }, "Added tasks from the compliance register");
    },
  };
}
