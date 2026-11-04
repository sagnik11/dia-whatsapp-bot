import type { SqlExecutor } from "./cloudflare-d1.js";
import { recordAudit, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";

export interface ChecklistItem {
  number: number;
  text: string;
  done: boolean;
}

interface ItemRow {
  task_id: number;
  position: number;
  text: string;
  done: number;
}

interface ChecklistStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  logger: Logger;
  now?: () => Date;
}

/** Numbered checklist items inside a task ("tick 2 and 3 on #8"). */
export class ChecklistStore {
  public constructor(private readonly options: ChecklistStoreOptions) {}

  public async add(taskId: number, texts: readonly string[], actor: string): Promise<ChecklistItem[]> {
    await this.options.schema.ensure();
    const existing = await this.items(taskId);
    let position = existing.reduce((max, item) => Math.max(max, item.number), 0);
    const now = this.nowIso();
    for (const raw of texts) {
      const text = raw.trim().slice(0, 300);
      if (!text) continue;
      position += 1;
      await this.options.db.query(
        "INSERT INTO task_items (task_id, position, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [taskId, position, text, now, now],
      );
    }
    const items = await this.items(taskId);
    await recordAudit(
      this.options.db,
      this.options.logger,
      { entity: "task_checklist", entityId: taskId, action: "added", actor, changes: { texts } },
      now,
    );
    return items;
  }

  /** Tick or untick items by their number; returns the full checklist and any unknown numbers. */
  public async setDone(
    taskId: number,
    numbers: readonly number[],
    done: boolean,
    actor: string,
  ): Promise<{ items: ChecklistItem[]; missing: number[] }> {
    await this.options.schema.ensure();
    const before = await this.items(taskId);
    const known = new Set(before.map((item) => item.number));
    const missing = numbers.filter((number) => !known.has(number));
    const now = this.nowIso();
    for (const number of numbers.filter((n) => known.has(n))) {
      await this.options.db.query(
        "UPDATE task_items SET done = ?, updated_at = ? WHERE task_id = ? AND position = ?",
        [done ? 1 : 0, now, taskId, number],
      );
    }
    await recordAudit(
      this.options.db,
      this.options.logger,
      { entity: "task_checklist", entityId: taskId, action: done ? "ticked" : "unticked", actor, changes: { numbers } },
      now,
    );
    return { items: await this.items(taskId), missing };
  }

  public async items(taskId: number): Promise<ChecklistItem[]> {
    return (await this.itemsFor([taskId])).get(taskId) ?? [];
  }

  public async itemsFor(taskIds: readonly number[]): Promise<Map<number, ChecklistItem[]>> {
    await this.options.schema.ensure();
    const map = new Map<number, ChecklistItem[]>();
    if (taskIds.length === 0) return map;
    const ids = [...new Set(taskIds)].slice(0, 90);
    const result = await this.options.db.query<ItemRow>(
      `SELECT task_id, position, text, done FROM task_items
       WHERE task_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY task_id, position`,
      ids,
    );
    for (const row of result.results) {
      const list = map.get(Number(row.task_id)) ?? [];
      list.push({ number: Number(row.position), text: row.text, done: Number(row.done) === 1 });
      map.set(Number(row.task_id), list);
    }
    return map;
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
