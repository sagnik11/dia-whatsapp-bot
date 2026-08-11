import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function normalizeDedupeKey(messageId: unknown): string {
  if (typeof messageId === "string" && messageId.length > 0) {
    return messageId;
  }

  if (
    typeof messageId === "number" ||
    typeof messageId === "bigint" ||
    typeof messageId === "boolean"
  ) {
    return String(messageId);
  }

  try {
    const serialized = JSON.stringify(messageId);
    if (typeof serialized === "string" && serialized.length > 0) {
      return serialized;
    }
  } catch {
    // Fall through to the explicit error below.
  }

  throw new TypeError("WhatsApp message ID could not be converted to a dedupe key");
}

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

  public claim(messageId: unknown): boolean {
    const dedupeKey = normalizeDedupeKey(messageId);
    const result = this.database
      .prepare("INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)")
      .run(dedupeKey);
    return result.changes === 1;
  }

  public has(messageId: unknown): boolean {
    const dedupeKey = normalizeDedupeKey(messageId);
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM processed_messages WHERE message_id = ? LIMIT 1")
        .get(dedupeKey),
    );
  }

  public close(): void {
    this.database.close();
  }
}
