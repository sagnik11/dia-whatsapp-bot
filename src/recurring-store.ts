import type { SqlExecutor } from "./cloudflare-d1.js";
import { recordAudit, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";
import type { TaskPriority, TaskStore } from "./task-store.js";
import { zonedParts } from "./time.js";

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  every: number;
  /** ISO weekday, 1 = Monday … 7 = Sunday (weekly rules). */
  weekday: number | null;
  /** 1–31, clamped to short months (monthly rules). */
  dayOfMonth: number | null;
}

export interface RecurringTaskInput {
  title: string;
  notes: string | null;
  owner: string | null;
  area: string | null;
  priority: TaskPriority | null;
  rule: RecurrenceRule;
  startsOn: string | null;
}

export interface RecurringTaskRecord {
  id: number;
  title: string;
  notes: string | null;
  owner: string | null;
  area: string | null;
  priority: TaskPriority | null;
  rule: RecurrenceRule;
  nextRunOn: string;
  active: boolean;
}

interface RecurringRow {
  id: number;
  title: string;
  notes: string | null;
  owner: string | null;
  area: string | null;
  priority: string | null;
  frequency: string;
  every: number;
  weekday: number | null;
  day_of_month: number | null;
  next_run_on: string;
  active: number;
}

const COLUMNS =
  "id, title, notes, owner, area, priority, frequency, every, weekday, day_of_month, next_run_on, active";

function rowToRecurring(row: RecurringRow): RecurringTaskRecord {
  return {
    id: Number(row.id),
    title: row.title,
    notes: row.notes,
    owner: row.owner,
    area: row.area,
    priority: (row.priority as TaskPriority | null) ?? null,
    rule: {
      frequency: row.frequency as RecurrenceFrequency,
      every: Number(row.every),
      weekday: row.weekday === null ? null : Number(row.weekday),
      dayOfMonth: row.day_of_month === null ? null : Number(row.day_of_month),
    },
    nextRunOn: row.next_run_on,
    active: Number(row.active) === 1,
  };
}

// --- Calendar math on local dates (YYYY-MM-DD) ------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): [number, number, number] {
  const match = DATE.exec(date);
  if (!match) throw new RangeError(`"${date}" is not a YYYY-MM-DD date`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function format(year: number, month: number, day: number): string {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isLocalDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = parts(value);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = parts(date);
  return format(year, month, day + days);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [year, month, day] = parts(date);
  const sundayZero = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayZero === 0 ? 7 : sundayZero;
}

function monthlyOn(year: number, month: number, dayOfMonth: number): string {
  return format(year, month, Math.min(dayOfMonth, daysInMonth(year, month)));
}

export function localDate(nowMs: number, timezone: string): string {
  const now = zonedParts(new Date(nowMs), timezone);
  return format(now.year ?? 1970, now.month ?? 1, now.day ?? 1);
}

/** First run on or after `from` that matches the rule. */
export function firstRunOn(rule: RecurrenceRule, from: string): string {
  if (rule.frequency === "daily") return from;
  if (rule.frequency === "weekly") {
    if (!rule.weekday) return from;
    return addDays(from, (rule.weekday - isoWeekday(from) + 7) % 7);
  }
  const [year, month, day] = parts(from);
  const dayOfMonth = rule.dayOfMonth ?? day;
  const thisMonth = monthlyOn(year, month, dayOfMonth);
  if (thisMonth >= from) return thisMonth;
  return monthlyOn(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, dayOfMonth);
}

/** The run after `previous`, honouring the interval. */
export function nextRunAfter(rule: RecurrenceRule, previous: string): string {
  const every = Math.max(1, rule.every);
  if (rule.frequency === "daily") return addDays(previous, every);
  if (rule.frequency === "weekly") return addDays(previous, 7 * every);
  const [year, month, day] = parts(previous);
  const total = month - 1 + every;
  return monthlyOn(year + Math.floor(total / 12), (total % 12) + 1, rule.dayOfMonth ?? day);
}

export function describeRule(rule: RecurrenceRule): string {
  const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const unit = { daily: "day", weekly: "week", monthly: "month" }[rule.frequency];
  const cadence = rule.every === 1 ? `every ${unit}` : `every ${rule.every} ${unit}s`;
  if (rule.frequency === "weekly" && rule.weekday) {
    return `${cadence} on ${weekdays.at(rule.weekday - 1) ?? "the same day"}`;
  }
  if (rule.frequency === "monthly" && rule.dayOfMonth) {
    return `${cadence} on day ${rule.dayOfMonth}`;
  }
  return cadence;
}

// --- Store --------------------------------------------------------------------

export class RecurringValidationError extends Error {}

interface RecurringStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  timezone: string;
  logger: Logger;
  now?: () => Date;
}

/** Templates that silently add a task to the list on each scheduled date. */
export class RecurringTaskStore {
  public constructor(private readonly options: RecurringStoreOptions) {}

  public async create(input: RecurringTaskInput, actor: string): Promise<RecurringTaskRecord> {
    await this.options.schema.ensure();
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new RecurringValidationError("A recurring task needs a title");
    const today = localDate(this.nowMs(), this.options.timezone);
    const start = input.startsOn?.trim() || today;
    if (!isLocalDate(start)) throw new RecurringValidationError(`"${start}" is not a YYYY-MM-DD date`);
    const nextRunOn = firstRunOn(input.rule, start < today ? today : start);
    const now = this.nowIso();
    const result = await this.options.db.query<RecurringRow>(
      `INSERT INTO recurring_tasks (
         title, notes, owner, area, priority, frequency, every, weekday, day_of_month,
         next_run_on, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
      [
        title,
        input.notes?.trim() || null,
        input.owner?.trim() || null,
        input.area?.trim() || null,
        input.priority,
        input.rule.frequency,
        Math.max(1, input.rule.every),
        input.rule.frequency === "weekly" ? input.rule.weekday : null,
        input.rule.frequency === "monthly" ? input.rule.dayOfMonth : null,
        nextRunOn,
        actor,
        now,
        now,
      ],
    );
    const row = result.results[0];
    if (!row) throw new Error("Recurring task could not be persisted");
    const record = rowToRecurring(row);
    await this.audit(record.id, "created", actor, record);
    return record;
  }

  public async list(includePaused = true): Promise<RecurringTaskRecord[]> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<RecurringRow>(
      `SELECT ${COLUMNS} FROM recurring_tasks
       WHERE deleted_at IS NULL ${includePaused ? "" : "AND active = 1"}
       ORDER BY next_run_on ASC, id ASC LIMIT 100`,
    );
    return result.results.map(rowToRecurring);
  }

  public async setState(
    id: number,
    action: "pause" | "resume" | "delete",
    actor: string,
  ): Promise<RecurringTaskRecord | null> {
    await this.options.schema.ensure();
    const current = await this.options.db.query<RecurringRow>(
      `SELECT ${COLUMNS} FROM recurring_tasks WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    const row = current.results[0];
    if (!row) return null;
    const before = rowToRecurring(row);
    const now = this.nowIso();
    if (action === "delete") {
      await this.options.db.query(
        "UPDATE recurring_tasks SET deleted_at = ?, updated_at = ? WHERE id = ?",
        [now, now, id],
      );
    } else if (action === "pause") {
      await this.options.db.query(
        "UPDATE recurring_tasks SET active = 0, updated_at = ? WHERE id = ?",
        [now, id],
      );
    } else {
      // Resuming never back-fills missed runs: start from today's next match.
      const nextRunOn = firstRunOn(before.rule, localDate(this.nowMs(), this.options.timezone));
      await this.options.db.query(
        "UPDATE recurring_tasks SET active = 1, next_run_on = ?, updated_at = ? WHERE id = ?",
        [nextRunOn, now, id],
      );
    }
    await this.audit(id, action, actor, before);
    const after = await this.options.db.query<RecurringRow>(
      `SELECT ${COLUMNS} FROM recurring_tasks WHERE id = ?`,
      [id],
    );
    return after.results[0] ? rowToRecurring(after.results[0]) : before;
  }

  /** Active templates whose next run is today or earlier (local date). */
  public async due(today: string): Promise<RecurringTaskRecord[]> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<RecurringRow>(
      `SELECT ${COLUMNS} FROM recurring_tasks
       WHERE active = 1 AND deleted_at IS NULL AND next_run_on <= ?
       ORDER BY next_run_on ASC, id ASC LIMIT 50`,
      [today],
    );
    return result.results.map(rowToRecurring);
  }

  /** Move a template past `today`, skipping runs missed while Patch was down. */
  public async advance(record: RecurringTaskRecord, today: string): Promise<string> {
    let next = nextRunAfter(record.rule, record.nextRunOn);
    while (next <= today) next = nextRunAfter(record.rule, next);
    await this.options.db.query(
      "UPDATE recurring_tasks SET next_run_on = ?, updated_at = ? WHERE id = ? AND next_run_on = ?",
      [next, this.nowIso(), record.id, record.nextRunOn],
    );
    return next;
  }

  private audit(id: number, action: string, actor: string, changes: unknown): Promise<void> {
    return recordAudit(
      this.options.db,
      this.options.logger,
      { entity: "recurring_task", entityId: id, action, actor, changes },
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

/** Add today's task for every due template, then move each template forward. */
export async function materializeRecurringTasks(input: {
  recurring: Pick<RecurringTaskStore, "due" | "advance">;
  tasks: Pick<TaskStore, "create">;
  timezone: string;
  nowMs: number;
  logger: Logger;
}): Promise<number> {
  const today = localDate(input.nowMs, input.timezone);
  let created = 0;
  for (const template of await input.recurring.due(today)) {
    try {
      const [result] = await input.tasks.create(
        [
          {
            title: template.title,
            notes: template.notes,
            status: null,
            priority: template.priority,
            owner: template.owner,
            area: template.area,
            dueAt: template.nextRunOn,
            tags: ["recurring"],
          },
        ],
        // The run date in the source id makes a retried run a no-op.
        { actor: "Patch (recurring)", groupName: null, messageId: `recurring:${template.id}:${template.nextRunOn}` },
      );
      if (result && !result.duplicate) created += 1;
      await input.recurring.advance(template, today);
    } catch (error) {
      input.logger.error({ error, recurringId: template.id }, "Could not add a recurring task; will retry");
    }
  }
  return created;
}
