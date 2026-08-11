import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ReminderCreateInput,
  ReminderPhase,
  ReminderRecord,
} from "./types.js";

interface ReminderRow {
  id: number;
  group_id: string;
  requested_by: string;
  requested_by_id: string;
  message: string;
  due_at_ms: number;
  notify_before_minutes: number;
  repeat_every_minutes: number | null;
  next_fire_at_ms: number;
  phase: ReminderPhase;
}

function rowToReminder(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    requestedBy: row.requested_by,
    requestedById: row.requested_by_id,
    message: row.message,
    dueAt: new Date(row.due_at_ms).toISOString(),
    notifyBeforeMinutes: row.notify_before_minutes,
    repeatEveryMinutes: row.repeat_every_minutes,
    nextFireAt: new Date(row.next_fire_at_ms).toISOString(),
    phase: row.phase,
  };
}

export class ReminderStore {
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_by_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL UNIQUE,
        message TEXT NOT NULL,
        due_at_ms INTEGER NOT NULL,
        notify_before_minutes INTEGER NOT NULL,
        repeat_every_minutes INTEGER,
        next_fire_at_ms INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('pre_due', 'due', 'repeat')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS reminders_due
      ON reminders(active, next_fire_at_ms);

      CREATE TABLE IF NOT EXISTS scheduler_state (
        key TEXT PRIMARY KEY,
        next_run_at_ms INTEGER NOT NULL
      );
    `);
  }

  public create(input: ReminderCreateInput, nowMs = Date.now()): ReminderRecord {
    const dueAtMs = Date.parse(input.dueAt);
    if (!Number.isFinite(dueAtMs)) {
      throw new TypeError("Reminder due time must be a valid ISO 8601 date or datetime");
    }
    if (dueAtMs < nowMs - 60_000) {
      throw new RangeError("Reminder due time cannot be in the past");
    }

    const preDueAtMs = dueAtMs - input.notifyBeforeMinutes * 60_000;
    const phase: ReminderPhase =
      input.notifyBeforeMinutes > 0 && preDueAtMs > nowMs ? "pre_due" : "due";
    const nextFireAtMs = phase === "pre_due" ? preDueAtMs : Math.max(nowMs, dueAtMs);

    this.database
      .prepare(
        `INSERT OR IGNORE INTO reminders (
          group_id, requested_by, requested_by_id, source_message_id, message,
          due_at_ms, notify_before_minutes, repeat_every_minutes,
          next_fire_at_ms, phase
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.groupId,
        input.requestedBy,
        input.requestedById,
        input.sourceMessageId,
        input.message,
        dueAtMs,
        input.notifyBeforeMinutes,
        input.repeatEveryMinutes,
        nextFireAtMs,
        phase,
      );

    const row = this.database
      .prepare(
        `SELECT id, group_id, requested_by, requested_by_id, message, due_at_ms,
                notify_before_minutes, repeat_every_minutes, next_fire_at_ms, phase
         FROM reminders WHERE source_message_id = ?`,
      )
      .get(input.sourceMessageId) as ReminderRow | undefined;
    if (!row) throw new Error("Reminder could not be persisted");
    return rowToReminder(row);
  }

  public listActive(groupId: string, limit = 20): ReminderRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, group_id, requested_by, requested_by_id, message, due_at_ms,
                notify_before_minutes, repeat_every_minutes, next_fire_at_ms, phase
         FROM reminders
         WHERE group_id = ? AND active = 1
         ORDER BY next_fire_at_ms ASC
         LIMIT ?`,
      )
      .all(groupId, limit) as unknown as ReminderRow[];
    return rows.map(rowToReminder);
  }

  public cancel(id: number, groupId: string): boolean {
    const result = this.database
      .prepare("UPDATE reminders SET active = 0 WHERE id = ? AND group_id = ?")
      .run(id, groupId);
    return result.changes === 1;
  }

  public due(nowMs = Date.now(), limit = 50): ReminderRecord[] {
    this.database
      .prepare(
        `UPDATE reminders SET phase = 'due', next_fire_at_ms = due_at_ms
         WHERE active = 1 AND phase = 'pre_due' AND due_at_ms <= ?`,
      )
      .run(nowMs);
    const rows = this.database
      .prepare(
        `SELECT id, group_id, requested_by, requested_by_id, message, due_at_ms,
                notify_before_minutes, repeat_every_minutes, next_fire_at_ms, phase
         FROM reminders
         WHERE active = 1 AND next_fire_at_ms <= ?
         ORDER BY next_fire_at_ms ASC
         LIMIT ?`,
      )
      .all(nowMs, limit) as unknown as ReminderRow[];
    return rows.map(rowToReminder);
  }

  public advanceAfterDelivery(reminder: ReminderRecord, nowMs = Date.now()): void {
    if (reminder.phase === "pre_due") {
      this.database
        .prepare(
          `UPDATE reminders SET phase = 'due', next_fire_at_ms = ?
           WHERE id = ? AND active = 1 AND next_fire_at_ms = ?`,
        )
        .run(
          Date.parse(reminder.dueAt),
          reminder.id,
          Date.parse(reminder.nextFireAt),
        );
      return;
    }

    if (reminder.repeatEveryMinutes) {
      const intervalMs = reminder.repeatEveryMinutes * 60_000;
      let nextFireAtMs = Date.parse(reminder.nextFireAt) + intervalMs;
      while (nextFireAtMs <= nowMs) nextFireAtMs += intervalMs;
      this.database
        .prepare(
          `UPDATE reminders SET phase = 'repeat', next_fire_at_ms = ?
           WHERE id = ? AND active = 1 AND next_fire_at_ms = ?`,
        )
        .run(nextFireAtMs, reminder.id, Date.parse(reminder.nextFireAt));
      return;
    }

    this.database
      .prepare(
        "UPDATE reminders SET active = 0 WHERE id = ? AND active = 1 AND next_fire_at_ms = ?",
      )
      .run(reminder.id, Date.parse(reminder.nextFireAt));
  }

  public getOrCreateNextRun(key: string, nowMs = Date.now()): number {
    this.database
      .prepare(
        "INSERT OR IGNORE INTO scheduler_state (key, next_run_at_ms) VALUES (?, ?)",
      )
      .run(key, nowMs);
    const row = this.database
      .prepare("SELECT next_run_at_ms FROM scheduler_state WHERE key = ?")
      .get(key) as { next_run_at_ms: number } | undefined;
    if (!row) throw new Error("Scheduler state could not be persisted");
    return row.next_run_at_ms;
  }

  public setNextRun(key: string, nextRunAtMs: number): void {
    this.database
      .prepare("UPDATE scheduler_state SET next_run_at_ms = ? WHERE key = ?")
      .run(nextRunAtMs, key);
  }

  public close(): void {
    this.database.close();
  }
}
