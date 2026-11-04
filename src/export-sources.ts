import { z } from "zod";
import {
  COMMON_EXPORT_FILTERS,
  type ExportContext,
  type ExportSource,
  type ExportTable,
} from "./assistant-export.js";
import type { ChecklistStore } from "./checklist-store.js";
import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import { escapeLike } from "./d1-schema.js";
import { FOLLOW_UP_STATUSES } from "./follow-up-store.js";
import { TASK_AREAS, TASK_STATUSES, type TaskStore } from "./task-store.js";
import { resolveDueTimestamp } from "./time.js";
import { ToolArgumentError } from "./tool-outcome.js";

/** What the built-in datasets read from. Reads only; nothing here writes. */
export interface CoreExportDeps {
  db: SqlExecutor;
  tasks: Pick<TaskStore, "ensureSchema" | "get">;
  /** Creates follow_ups and task_items on first use (the Phase 1 SchemaGate). */
  phase1Schema: { ensure(): Promise<void> };
  checklists: Pick<ChecklistStore, "items">;
}

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || null);

const STATUS_ALIASES: Readonly<Record<string, string>> = {
  canceled: "cancelled",
  complete: "done",
  completed: "done",
  closed: "done",
};

const statusList = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .array(
      z.preprocess((value) => {
        if (typeof value !== "string") return value;
        const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
        return STATUS_ALIASES[key] ?? key;
      }, z.enum(values)),
    )
    .max(5)
    .nullish();

/** An ISO timestamp as "YYYY-MM-DD HH:mm" in the group's timezone, which Excel reads as a date. */
export function localStamp(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Due dates stay as dates; due datetimes become local timestamps. */
function localDue(value: string | null, timezone: string): string | null {
  if (!value || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return localStamp(value, timezone);
}

function owner(value: string | null, context: ExportContext): string | null {
  if (!value) return null;
  return /^(?:me|myself|i)$/i.test(value) ? context.request.requestedBy : value;
}

function dueBound(value: string | null, field: string, timezone: string, edge: "start" | "end") {
  if (!value) return null;
  const timestamp = resolveDueTimestamp(value, timezone, edge);
  if (timestamp === null) throw new ToolArgumentError(`${field} "${value}" is not an ISO 8601 date`);
  return timestamp;
}

function parseTags(value: string | null): string {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string").join("; ") : "";
  } catch {
    return "";
  }
}

/** Limit + 1 rows are fetched so truncation is detected without a COUNT query. */
function capped<T>(rows: readonly T[], limit: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

// --- Tasks -----------------------------------------------------------------------

const taskFiltersSchema = z.object({
  statuses: statusList(TASK_STATUSES),
  include_closed: z.boolean().nullish(),
  owner: optionalText(100),
  area: optionalText(50),
  tag: optionalText(40),
  text: optionalText(200),
  due_from: optionalText(100),
  due_to: optionalText(100),
  overdue_only: z.boolean().nullish(),
});

interface TaskExportRow {
  id: number;
  title: string;
  notes: string | null;
  status: string;
  priority: string | null;
  owner: string | null;
  area: string | null;
  due_at: string | null;
  tags: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function taskExportSource(deps: CoreExportDeps, now: () => Date = () => new Date()): ExportSource {
  return {
    name: "tasks",
    description:
      "the task list; open tasks by default, filter by statuses, include_closed, owner, area, tag, text, due_from, due_to, overdue_only.",
    filters: {
      ...COMMON_EXPORT_FILTERS,
      area: { type: "string", enum: [...TASK_AREAS] },
      tag: { type: "string" },
      due_from: { type: "string", description: "Inclusive ISO 8601 start date." },
      due_to: { type: "string", description: "Inclusive ISO 8601 end date." },
      overdue_only: { type: "boolean" },
    },
    async load(args, context): Promise<ExportTable> {
      const filters = taskFiltersSchema.parse(args);
      const where = ["deleted_at IS NULL"];
      const params: SqlValue[] = [];
      if (filters.statuses?.length) {
        where.push(`status IN (${filters.statuses.map(() => "?").join(", ")})`);
        params.push(...filters.statuses);
      } else if (!filters.include_closed) {
        where.push("status NOT IN ('done', 'cancelled')");
      }
      const who = owner(filters.owner, context);
      if (who) {
        where.push("lower(owner) = lower(?)");
        params.push(who);
      }
      if (filters.area) {
        where.push("lower(area) = lower(?)");
        params.push(filters.area);
      }
      if (filters.tag) {
        where.push("EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE lower(json_each.value) = lower(?))");
        params.push(filters.tag.replace(/^#/, ""));
      }
      if (filters.text) {
        const pattern = `%${escapeLike(filters.text)}%`;
        where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern);
      }
      const from = dueBound(filters.due_from, "due_from", context.timezone, "start");
      const to = dueBound(filters.due_to, "due_to", context.timezone, "end");
      if (from !== null) {
        where.push("due_ts >= ?");
        params.push(from);
      }
      if (to !== null) {
        where.push("due_ts <= ?");
        params.push(to);
      }
      if (filters.overdue_only) {
        where.push("due_ts < ? AND status NOT IN ('done', 'cancelled')");
        params.push(now().getTime());
      }
      await deps.tasks.ensureSchema();
      const result = await deps.db.query<TaskExportRow>(
        `SELECT id, title, notes, status, priority, owner, area, due_at, tags,
                created_by, created_at, updated_at, completed_at
         FROM tasks WHERE ${where.join(" AND ")}
         ORDER BY CASE WHEN due_ts IS NULL THEN 1 ELSE 0 END, due_ts ASC, id ASC
         LIMIT ?`,
        [...params, context.limit + 1],
      );
      const { rows, truncated } = capped(result.results, context.limit);
      const kind = filters.overdue_only
        ? "overdue"
        : filters.statuses?.length
          ? filters.statuses.join(" and ").replace(/_/g, " ")
          : filters.include_closed
            ? "all"
            : "open";
      return {
        label: `${kind} tasks${who ? ` for ${who}` : ""}`,
        columns: ["ID", "Title", "Status", "Priority", "Owner", "Area", "Due", "Tags", "Notes", "Created by", "Created", "Updated", "Completed"],
        rows: rows.map((row) => [
          Number(row.id), row.title, row.status, row.priority, row.owner, row.area,
          localDue(row.due_at, context.timezone), parseTags(row.tags), row.notes, row.created_by,
          localStamp(row.created_at, context.timezone), localStamp(row.updated_at, context.timezone),
          localStamp(row.completed_at, context.timezone),
        ]),
        truncated,
      };
    },
  };
}

// --- Follow-ups --------------------------------------------------------------------

const followUpFiltersSchema = z.object({
  statuses: statusList(FOLLOW_UP_STATUSES),
  include_closed: z.boolean().nullish(),
  owner: optionalText(100),
  counterparty: optionalText(100),
  text: optionalText(200),
});

interface FollowUpExportRow {
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

export function followUpExportSource(deps: CoreExportDeps): ExportSource {
  return {
    name: "follow_ups",
    description:
      "promises to or from people outside the group (F<id>); open by default, filter by statuses, include_closed, owner, counterparty, text.",
    filters: {
      ...COMMON_EXPORT_FILTERS,
      counterparty: { type: "string", description: "Outside person or company." },
    },
    async load(args, context): Promise<ExportTable> {
      const filters = followUpFiltersSchema.parse(args);
      const statuses = filters.statuses?.length
        ? filters.statuses
        : filters.include_closed
          ? [...FOLLOW_UP_STATUSES]
          : ["open"];
      const where = [`status IN (${statuses.map(() => "?").join(", ")})`];
      const params: SqlValue[] = [...statuses];
      const who = owner(filters.owner, context);
      if (who) {
        where.push("lower(owner) = lower(?)");
        params.push(who);
      }
      if (filters.counterparty) {
        where.push("counterparty LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(filters.counterparty)}%`);
      }
      if (filters.text) {
        const pattern = `%${escapeLike(filters.text)}%`;
        where.push("(promise LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern);
      }
      await deps.phase1Schema.ensure();
      const result = await deps.db.query<FollowUpExportRow>(
        `SELECT id, owner, counterparty, promise, due_at, status, notes, created_by, created_at, closed_at
         FROM follow_ups WHERE ${where.join(" AND ")}
         ORDER BY CASE WHEN due_ts IS NULL THEN 1 ELSE 0 END, due_ts ASC, id ASC
         LIMIT ?`,
        [...params, context.limit + 1],
      );
      const { rows, truncated } = capped(result.results, context.limit);
      const kind = filters.statuses?.length
        ? filters.statuses.join(" and ")
        : filters.include_closed
          ? "all"
          : "open";
      return {
        label: `${kind} follow-ups${who ? ` for ${who}` : ""}`,
        columns: ["Ref", "Owner", "Counterparty", "Promise", "Status", "Due", "Notes", "Created by", "Created", "Closed"],
        rows: rows.map((row) => [
          `F${row.id}`, row.owner, row.counterparty, row.promise, row.status,
          localDue(row.due_at, context.timezone), row.notes, row.created_by,
          localStamp(row.created_at, context.timezone), localStamp(row.closed_at, context.timezone),
        ]),
        truncated,
      };
    },
  };
}

// --- Checklist of one task ------------------------------------------------------------

const checklistFiltersSchema = z.object({
  task_id: z.coerce.number().int().positive().nullish(),
});

export function checklistExportSource(deps: CoreExportDeps): ExportSource {
  return {
    name: "checklist",
    description: "the numbered checklist inside one task; needs task_id.",
    filters: {
      task_id: { type: "integer", minimum: 1, description: "Task #id, for the checklist dataset." },
    },
    async load(args, context): Promise<ExportTable> {
      const { task_id: taskId } = checklistFiltersSchema.parse(args);
      if (!taskId) throw new ToolArgumentError("the checklist dataset needs task_id");
      const task = await deps.tasks.get(taskId);
      if (!task) throw new ToolArgumentError(`task #${taskId} does not exist or was deleted`);
      const { rows, truncated } = capped(await deps.checklists.items(task.id), context.limit);
      return {
        label: `checklist of #${task.id} ${task.title}`,
        columns: ["Task ID", "Task", "Item", "Text", "Done"],
        rows: rows.map((item) => [task.id, task.title, item.number, item.text, item.done ? "yes" : "no"]),
        truncated,
      };
    },
  };
}

/** The datasets Patch ships with: tasks, follow_ups and checklist. */
export function coreExportSources(deps: CoreExportDeps): ExportSource[] {
  return [taskExportSource(deps), followUpExportSource(deps), checklistExportSource(deps)];
}
