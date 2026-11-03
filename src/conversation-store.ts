import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_BODY_CHARACTERS = 4_000;

export interface ConversationMessageInput {
  groupId: string;
  messageId: string;
  author: string;
  body: string;
  fromBot: boolean;
  sentAtMs: number;
}

export interface ConversationMessage {
  messageId: string;
  author: string;
  body: string;
  fromBot: boolean;
  sentAt: string;
}

export interface ConversationQuery {
  sinceMs: number;
  untilMs?: number;
  text?: string | null;
  /** The newest messages win when the window holds more than this. */
  limit: number;
}

interface ConversationRow {
  message_id: string;
  author: string;
  body: string;
  from_bot: number;
  sent_at_ms: number;
}

function rowToMessage(row: ConversationRow): ConversationMessage {
  return {
    messageId: row.message_id,
    author: row.author,
    body: row.body,
    fromBot: row.from_bot === 1,
    sentAt: new Date(row.sent_at_ms).toISOString(),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * The group's own conversation, kept on the bot's server so briefs and
 * answers can be grounded in what founders actually said. Stored locally
 * (not in D1) to keep raw chat off third-party storage and to avoid one
 * D1 REST call per WhatsApp message.
 */
export class ConversationStore {
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        from_bot INTEGER NOT NULL DEFAULT 0,
        sent_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS conversation_group_time
      ON conversation_messages(group_id, sent_at_ms);
    `);
  }

  /**
   * Store one message. Re-recording the same message id is ignored, except
   * that Patch's own record of a reply it sent replaces the echo WhatsApp
   * delivers for it, so replies are always attributed to Patch.
   */
  public record(input: ConversationMessageInput): void {
    const body = input.body.trim().slice(0, MAX_BODY_CHARACTERS);
    if (!body) return;
    this.database
      .prepare(
        `INSERT INTO conversation_messages
           (group_id, message_id, author, body, from_bot, sent_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_id) DO UPDATE SET
           author = excluded.author,
           from_bot = excluded.from_bot
         WHERE excluded.from_bot = 1`,
      )
      .run(
        input.groupId,
        input.messageId,
        input.author.trim().slice(0, 100) || "Unknown member",
        body,
        input.fromBot ? 1 : 0,
        input.sentAtMs,
      );
  }

  /** Messages in one group, oldest first, newest kept when over the limit. */
  public list(groupId: string, query: ConversationQuery): ConversationMessage[] {
    const where = ["group_id = ?", "sent_at_ms >= ?", "sent_at_ms <= ?"];
    const params: Array<string | number> = [
      groupId,
      query.sinceMs,
      query.untilMs ?? Number.MAX_SAFE_INTEGER,
    ];
    if (query.text?.trim()) {
      where.push("(body LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(query.text.trim())}%`;
      params.push(pattern, pattern);
    }
    const limit = Math.max(1, Math.min(Math.trunc(query.limit), 1_000));
    const rows = this.database
      .prepare(
        `SELECT message_id, author, body, from_bot, sent_at_ms
         FROM conversation_messages
         WHERE ${where.join(" AND ")}
         ORDER BY sent_at_ms DESC, id DESC
         LIMIT ${limit}`,
      )
      .all(...params) as unknown as ConversationRow[];
    return rows.reverse().map(rowToMessage);
  }

  /** Whether any founder (not Patch) said something in the window. */
  public hasHumanMessages(groupId: string, sinceMs: number, untilMs: number): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS found FROM conversation_messages
         WHERE group_id = ? AND from_bot = 0 AND sent_at_ms >= ? AND sent_at_ms <= ?
         LIMIT 1`,
      )
      .get(groupId, sinceMs, untilMs);
    return Boolean(row);
  }

  /** Delete messages older than the cutoff; returns how many were removed. */
  public prune(olderThanMs: number): number {
    const result = this.database
      .prepare("DELETE FROM conversation_messages WHERE sent_at_ms < ?")
      .run(olderThanMs);
    return Number(result.changes);
  }

  public close(): void {
    this.database.close();
  }
}
