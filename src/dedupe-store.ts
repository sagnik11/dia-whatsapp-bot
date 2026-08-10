import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class DedupeStore {
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  public claim(messageId: string): boolean {
    const result = this.database
      .prepare("INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)")
      .run(messageId);
    return result.changes === 1;
  }

  public close(): void {
    this.database.close();
  }
}
