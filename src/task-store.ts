import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import type { Logger } from "./logger.js";
import { resolveDueTimestamp } from "./time.js";

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["high", "medium", "low"] as const;
export const TASK_AREAS = [
  "Product",
  "Tech",
  "Marketing",
  "Content",
  "Sales",
  "Hiring",
  "Finance",
  "Ops",
  "Legal",
  "Misc",
] as const;
export const CLEARABLE_TASK_FIELDS = ["due_at", "owner", "priority", "area", "tags", "notes"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskArea = (typeof TASK_AREAS)[number];
export type ClearableTaskField = (typeof CLEARABLE_TASK_FIELDS)[number];

const CLOSED_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];
const MAX_NOTES_CHARACTERS = 20_000;
const MAX_TAGS = 10;

/** Keep in sync with migrations/0001_tasks.sql (a test enforces this). */
export const TASK_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
  owner TEXT,
  area TEXT,
  due_at TEXT,
  due_ts INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  source_group TEXT,
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT,
  UNIQUE (source_message_id, title)
)`,
  "CREATE INDEX IF NOT EXISTS tasks_open_due ON tasks (deleted_at, status, due_ts)",
  "CREATE INDEX IF NOT EXISTS tasks_owner ON tasks (deleted_at, owner)",
  `CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  actor TEXT NOT NULL,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, id)",
];

export interface TaskRecord {
  id: number;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority | null;
  owner: string | null;
  area: string | null;
  dueAt: string | null;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskCreateInput {
  title: string;
  notes: string | null;
  status: TaskStatus | null;
  priority: TaskPriority | null;
  owner: string | null;
  area: string | null;
  dueAt: string | null;
  tags: string[];
}

export interface TaskCreateSource {
  actor: string;
  groupName: string | null;
  messageId: string | null;
}

export interface TaskCreateResult {
  task: TaskRecord;
  duplicate: boolean;
}

export interface TaskPatch {
  title: string | null;
  status: TaskStatus | null;
  priority: TaskPriority | null;
  owner: string | null;
  area: string | null;
  dueAt: string | null;
  tags: string[] | null;
  notesMode: "append" | "replace" | null;
  notes: string | null;
  clear: ClearableTaskField[];
}

export interface TaskUpdateResult {
  before: TaskRecord;
  after: TaskRecord;
  changedFields: string[];
}

export interface TaskListQuery {
  text: string | null;
  statuses: TaskStatus[] | null;
  includeClosed: boolean;
  owner: string | null;
  area: string | null;
  tag: string | null;
  dueFrom: string | null;
  dueTo: string | null;
  overdueOnly: boolean;
  limit: number;
}

export interface TaskListResult {
  tasks: TaskRecord[];
  hasMore: boolean;
}

export type UndoResult =
  | { action: "removed" | "restored"; task: TaskRecord }
  | { action: "reverted"; task: TaskRecord; fields: string[] };

export class TaskNotFoundError extends Error {
  public constructor(public readonly taskId: number) {
    super(`Task #${taskId} does not exist or was deleted`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

interface TaskRow {
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

const TASK_COLUMNS =
  "id, title, notes, status, priority, owner, area, due_at, tags, created_by, created_at, updated_at, completed_at";

function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    id: Number(row.id),
    title: row.title,
    notes: row.notes,
    status: row.status as TaskStatus,
    priority: (row.priority as TaskPriority | null) ?? null,
    owner: row.owner,
    area: row.area,
    dueAt: row.due_at,
    tags: parseTags(row.tags),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function normalizeTags(tags: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const tag of tags) {
    const cleaned = tag.trim().replace(/^#/, "").slice(0, 40);
    if (cleaned && !unique.has(cleaned.toLowerCase())) {
      unique.set(cleaned.toLowerCase(), cleaned);
    }
  }
  return [...unique.values()].slice(0, MAX_TAGS);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function cleanText(value: string | null, maxLength: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

export function isClosedStatus(status: TaskStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

interface TaskStoreOptions {
  db: SqlExecutor;
  timezone: string;
  logger: Logger;
  now?: () => Date;
}

export class TaskStore {
  private schemaReady: Promise<void> | undefined;

  public constructor(private readonly options: TaskStoreOptions) {}

  /** Create the tables and indexes if they are missing. Safe to call repeatedly. */
  public ensureSchema(): Promise<void> {
    this.schemaReady ??= (async () => {
      for (const statement of TASK_SCHEMA_STATEMENTS) {
        await this.options.db.query(statement);
      }
      this.options.logger.info("Task list schema is ready in Cloudflare D1");
    })().catch((error: unknown) => {
      this.schemaReady = undefined;
      throw error;
    });
    return this.schemaReady;
  }

  public async create(
    inputs: readonly TaskCreateInput[],
    source: TaskCreateSource,
  ): Promise<TaskCreateResult[]> {
    await this.ensureSchema();
    const results: TaskCreateResult[] = [];
    for (const input of inputs) {
      const title = cleanText(input.title, 200);
      if (!title) throw new TaskValidationError("Every task needs a title");
      const dueTs = this.dueTimestamp(input.dueAt);
      const status = input.status ?? "todo";
      const now = this.nowIso();
      const tags = normalizeTags(input.tags);
      const inserted = await this.options.db.query<TaskRow>(
        `INSERT INTO tasks (
           title, notes, status, priority, owner, area, due_at, due_ts, tags,
           created_by, updated_by, source_group, source_message_id,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_message_id, title) DO NOTHING
         RETURNING ${TASK_COLUMNS}`,
        [
          title,
          cleanText(input.notes, MAX_NOTES_CHARACTERS),
          status,
          input.priority,
          cleanText(input.owner, 100),
          cleanText(input.area, 50),
          cleanText(input.dueAt, 100),
          dueTs,
          JSON.stringify(tags),
          source.actor,
          source.actor,
          source.groupName,
          source.messageId,
          now,
          now,
          isClosedStatus(status) ? now : null,
        ],
      );
      const created = inserted.results[0];
      if (created) {
        const task = rowToTask(created);
        await this.recordEvent(task.id, "created", source.actor, { task });
        results.push({ task, duplicate: false });
        continue;
      }

      const existing = await this.options.db.query<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE source_message_id = ? AND title = ? AND deleted_at IS NULL`,
        [source.messageId, title],
      );
      const row = existing.results[0];
      if (!row) throw new Error(`Task "${title}" could not be persisted`);
      results.push({ task: rowToTask(row), duplicate: true });
    }
    this.options.logger.info(
      {
        created: results.filter((result) => !result.duplicate).length,
        duplicates: results.filter((result) => result.duplicate).length,
      },
      "Created tasks in Cloudflare D1",
    );
    return results;
  }

  public async get(id: number): Promise<TaskRecord | null> {
    await this.ensureSchema();
    const result = await this.options.db.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    const row = result.results[0];
    return row ? rowToTask(row) : null;
  }

  public async list(query: TaskListQuery): Promise<TaskListResult> {
    await this.ensureSchema();
    const where: string[] = ["deleted_at IS NULL"];
    const params: SqlValue[] = [];

    if (query.statuses?.length) {
      where.push(`status IN (${query.statuses.map(() => "?").join(", ")})`);
      params.push(...query.statuses);
    } else if (!query.includeClosed) {
      where.push("status NOT IN ('done', 'cancelled')");
    }
    if (query.text?.trim()) {
      const pattern = `%${escapeLike(query.text.trim())}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    if (query.owner?.trim()) {
      // "Sagnik" also finds "Sagnik Ghosh", and the other way round.
      const owner = query.owner.trim();
      where.push(
        "(lower(owner) = lower(?) OR lower(owner) LIKE lower(?) ESCAPE '\\' OR lower(?) LIKE lower(owner) || ' %')",
      );
      params.push(owner, `${escapeLike(owner)} %`, owner);
    }
    if (query.area?.trim()) {
      where.push("lower(area) = lower(?)");
      params.push(query.area.trim());
    }
    if (query.tag?.trim()) {
      where.push(
        "EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE lower(json_each.value) = lower(?))",
      );
      params.push(query.tag.trim().replace(/^#/, ""));
    }
    if (query.dueFrom) {
      const from = resolveDueTimestamp(query.dueFrom, this.options.timezone, "start");
      if (from === null) throw new TaskValidationError("due_from is not a valid date");
      where.push("due_ts >= ?");
      params.push(from);
    }
    if (query.dueTo) {
      const to = resolveDueTimestamp(query.dueTo, this.options.timezone, "end");
      if (to === null) throw new TaskValidationError("due_to is not a valid date");
      where.push("due_ts <= ?");
      params.push(to);
    }
    if (query.overdueOnly) {
      where.push("due_ts < ? AND status NOT IN ('done', 'cancelled')");
      params.push(this.now().getTime());
    }

    const limit = Math.max(1, Math.min(query.limit, 100));
    const result = await this.options.db.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE WHEN due_ts IS NULL THEN 1 ELSE 0 END,
         due_ts ASC,
         CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
         id ASC
       LIMIT ?`,
      [...params, limit + 1],
    );
    return {
      tasks: result.results.slice(0, limit).map(rowToTask),
      hasMore: result.results.length > limit,
    };
  }

  public listOpen(limit = 100): Promise<TaskListResult> {
    return this.list({
      text: null,
      statuses: null,
      includeClosed: false,
      owner: null,
      area: null,
      tag: null,
      dueFrom: null,
      dueTo: null,
      overdueOnly: false,
      limit,
    });
  }

  public async update(
    id: number,
    patch: TaskPatch,
    actor: string,
    meta: Readonly<Record<string, unknown>> = {},
  ): Promise<TaskUpdateResult> {
    await this.ensureSchema();
    const before = await this.get(id);
    if (!before) throw new TaskNotFoundError(id);

    const clear = new Set(patch.clear);
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    const changedFields: string[] = [];
    const set = (column: string, value: SqlValue, field = column): void => {
      assignments.push(`${column} = ?`);
      params.push(value);
      if (!changedFields.includes(field)) changedFields.push(field);
    };

    const newTitle = cleanText(patch.title, 200);
    if (newTitle && newTitle !== before.title) set("title", newTitle);

    if (patch.status && patch.status !== before.status) {
      set("status", patch.status);
      const wasClosed = isClosedStatus(before.status);
      const willClose = isClosedStatus(patch.status);
      if (willClose && !wasClosed) set("completed_at", this.nowIso(), "status");
      if (!willClose && wasClosed) set("completed_at", null, "status");
    }

    if (clear.has("priority")) {
      if (before.priority !== null) set("priority", null);
    } else if (patch.priority && patch.priority !== before.priority) {
      set("priority", patch.priority);
    }

    if (clear.has("owner")) {
      if (before.owner !== null) set("owner", null);
    } else {
      const owner = cleanText(patch.owner, 100);
      if (owner && owner.toLowerCase() !== before.owner?.toLowerCase()) set("owner", owner);
    }

    if (clear.has("area")) {
      if (before.area !== null) set("area", null);
    } else {
      const area = cleanText(patch.area, 50);
      if (area && area !== before.area) set("area", area);
    }

    if (clear.has("due_at")) {
      if (before.dueAt !== null) {
        set("due_at", null);
        set("due_ts", null, "due_at");
      }
    } else {
      const dueAt = cleanText(patch.dueAt, 100);
      if (dueAt && dueAt !== before.dueAt) {
        set("due_at", dueAt);
        set("due_ts", this.dueTimestamp(dueAt), "due_at");
      }
    }

    if (clear.has("tags")) {
      if (before.tags.length > 0) set("tags", "[]");
    } else if (patch.tags) {
      const tags = normalizeTags(patch.tags);
      if (JSON.stringify(tags) !== JSON.stringify(before.tags)) {
        set("tags", JSON.stringify(tags));
      }
    }

    if (clear.has("notes")) {
      if (before.notes !== null) set("notes", null);
    } else if (patch.notesMode && patch.notes?.trim()) {
      const addition = patch.notes.trim();
      const notes =
        patch.notesMode === "append" && before.notes
          ? `${before.notes}\n\n${addition}`
          : addition;
      if (notes.length > MAX_NOTES_CHARACTERS) {
        throw new TaskValidationError(
          `Task notes would exceed ${MAX_NOTES_CHARACTERS} characters`,
        );
      }
      if (notes !== before.notes) set("notes", notes);
    }

    if (assignments.length === 0) {
      return { before, after: before, changedFields: [] };
    }

    const now = this.nowIso();
    const updated = await this.options.db.query<TaskRow>(
      `UPDATE tasks SET ${assignments.join(", ")}, updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
       RETURNING ${TASK_COLUMNS}`,
      [...params, actor, now, id],
    );
    const row = updated.results[0];
    if (!row) throw new TaskNotFoundError(id);
    const after = rowToTask(row);
    const diff = Object.fromEntries(
      changedFields.map((field) => {
        const key = (field === "due_at" ? "dueAt" : field) as keyof TaskRecord;
        return [field, { from: before[key], to: after[key] }];
      }),
    );
    await this.recordEvent(id, "updated", actor, { ...diff, ...meta });
    return { before, after, changedFields };
  }

  /** Soft-delete: the row disappears from every list but stays in D1 for audit. */
  public async delete(
    id: number,
    actor: string,
    meta: Readonly<Record<string, unknown>> = {},
  ): Promise<TaskRecord> {
    await this.ensureSchema();
    const before = await this.get(id);
    if (!before) throw new TaskNotFoundError(id);
    const now = this.nowIso();
    const result = await this.options.db.query(
      "UPDATE tasks SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL",
      [now, now, actor, id],
    );
    if (result.changes === 0) throw new TaskNotFoundError(id);
    await this.recordEvent(id, "deleted", actor, { task: before, ...meta });
    return before;
  }

  /** Bring back a soft-deleted task. */
  public async restore(
    id: number,
    actor: string,
    meta: Readonly<Record<string, unknown>> = {},
  ): Promise<TaskRecord> {
    await this.ensureSchema();
    const now = this.nowIso();
    const result = await this.options.db.query<TaskRow>(
      `UPDATE tasks SET deleted_at = NULL, updated_at = ?, updated_by = ?
       WHERE id = ? AND deleted_at IS NOT NULL
       RETURNING ${TASK_COLUMNS}`,
      [now, actor, id],
    );
    const row = result.results[0];
    if (!row) throw new TaskNotFoundError(id);
    const task = rowToTask(row);
    await this.recordEvent(id, "updated", actor, { restored: true, ...meta });
    return task;
  }

  /** Tasks finished or dropped since a moment, newest first (for reviews). */
  public async listClosedSince(sinceIso: string, limit = 100): Promise<TaskRecord[]> {
    await this.ensureSchema();
    const result = await this.options.db.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE deleted_at IS NULL AND completed_at IS NOT NULL AND completed_at >= ?
       ORDER BY completed_at DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`,
      [sinceIso],
    );
    return result.results.map(rowToTask);
  }

  /**
   * Reverse the actor's most recent task change from the last 24 hours that
   * has not been undone yet. Repeated undos step further back.
   */
  public async undoLast(actor: string): Promise<UndoResult | null> {
    await this.ensureSchema();
    const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1_000).toISOString();
    const result = await this.options.db.query<{
      id: number;
      task_id: number;
      action: string;
      changes: string;
    }>(
      `SELECT id, task_id, action, changes FROM task_events
       WHERE actor = ? AND created_at >= ?
         AND json_extract(changes, '$.undoOf') IS NULL
         AND id NOT IN (
           SELECT json_extract(changes, '$.undoOf') FROM task_events
           WHERE json_extract(changes, '$.undoOf') IS NOT NULL
         )
       ORDER BY id DESC LIMIT 1`,
      [actor, since],
    );
    const event = result.results[0];
    if (!event) return null;
    const meta = { undoOf: Number(event.id) };
    const taskId = Number(event.task_id);

    if (event.action === "created") {
      return { action: "removed", task: await this.delete(taskId, actor, meta) };
    }
    if (event.action === "deleted") {
      return { action: "restored", task: await this.restore(taskId, actor, meta) };
    }

    const changes = JSON.parse(event.changes) as Record<string, { from?: unknown } | unknown>;
    const from = (field: string): unknown => {
      const change = changes[field];
      return change && typeof change === "object" && "from" in change ? change.from : undefined;
    };
    if (changes.restored) {
      return { action: "removed", task: await this.delete(taskId, actor, meta) };
    }
    const clear: ClearableTaskField[] = [];
    const textOrClear = (field: ClearableTaskField, key: string): string | null => {
      if (!(key in changes)) return null;
      const value = from(key);
      if (value === null || value === undefined || value === "") {
        clear.push(field);
        return null;
      }
      return String(value);
    };
    const tagsBefore = from("tags");
    if ("tags" in changes && Array.isArray(tagsBefore) && tagsBefore.length === 0) {
      clear.push("tags");
    }
    const notes = textOrClear("notes", "notes");
    const patch: TaskPatch = {
      title: "title" in changes ? String(from("title") ?? "") || null : null,
      status: "status" in changes ? ((from("status") as TaskStatus | undefined) ?? null) : null,
      priority: textOrClear("priority", "priority") as TaskPriority | null,
      owner: textOrClear("owner", "owner"),
      area: textOrClear("area", "area"),
      dueAt: textOrClear("due_at", "due_at"),
      tags:
        "tags" in changes && Array.isArray(tagsBefore) && tagsBefore.length > 0
          ? tagsBefore.map(String)
          : null,
      notesMode: notes ? "replace" : null,
      notes,
      clear,
    };
    const reverted = await this.update(taskId, patch, actor, meta);
    if (reverted.changedFields.length === 0) {
      // Already back to how it was; still mark the event so the next undo steps further back.
      await this.recordEvent(taskId, "updated", actor, { noop: true, ...meta });
    }
    return { action: "reverted", task: reverted.after, fields: reverted.changedFields };
  }

  private async recordEvent(
    taskId: number,
    action: "created" | "updated" | "deleted",
    actor: string,
    changes: unknown,
  ): Promise<void> {
    try {
      await this.options.db.query(
        "INSERT INTO task_events (task_id, action, actor, changes, created_at) VALUES (?, ?, ?, ?, ?)",
        [taskId, action, actor, JSON.stringify(changes), this.nowIso()],
      );
    } catch (error) {
      // The task write already succeeded; a missing audit row must not turn it
      // into a reported failure.
      this.options.logger.warn({ error, taskId, action }, "Could not record task event");
    }
  }

  private dueTimestamp(dueAt: string | null): number | null {
    const trimmed = dueAt?.trim();
    if (!trimmed) return null;
    const timestamp = resolveDueTimestamp(trimmed, this.options.timezone);
    if (timestamp === null) {
      throw new TaskValidationError(`"${trimmed}" is not a valid due date`);
    }
    return timestamp;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
