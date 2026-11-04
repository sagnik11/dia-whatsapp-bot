import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import type {
  ConversationLog,
  ConversationMessage,
  ConversationMessageInput,
  ConversationQuery,
  ConversationStore,
} from "./conversation-store.js";
import { escapeLike, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";

const MAX_BODY_CHARACTERS = 4_000;

/** Keep in sync with migrations/0007_conversation.sql (a test enforces this). */
export const CONVERSATION_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  from_bot INTEGER NOT NULL DEFAULT 0,
  sent_at_ms INTEGER NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS conversation_group_time ON conversation_messages (group_id, sent_at_ms)",
];

interface Row {
  message_id: string;
  author: string;
  body: string;
  from_bot: number;
  sent_at_ms: number;
}

function rowToMessage(row: Row): ConversationMessage {
  return {
    messageId: row.message_id,
    author: row.author,
    body: row.body,
    fromBot: Number(row.from_bot) === 1,
    sentAt: new Date(Number(row.sent_at_ms)).toISOString(),
  };
}

interface D1ConversationStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  logger: Logger;
}

/**
 * The group conversation in Cloudflare D1 (founders' decision once the Patch
 * API Worker exists). Same behaviour as the local SQLite store.
 */
export class D1ConversationStore implements ConversationLog {
  public constructor(private readonly options: D1ConversationStoreOptions) {}

  public async record(input: ConversationMessageInput): Promise<void> {
    const body = input.body.trim().slice(0, MAX_BODY_CHARACTERS);
    if (!body) return;
    await this.options.schema.ensure();
    await this.options.db.query(
      `INSERT INTO conversation_messages
         (group_id, message_id, author, body, from_bot, sent_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET
         author = excluded.author,
         from_bot = excluded.from_bot
       WHERE excluded.from_bot = 1`,
      [
        input.groupId,
        input.messageId,
        input.author.trim().slice(0, 100) || "Unknown member",
        body,
        input.fromBot ? 1 : 0,
        input.sentAtMs,
      ],
    );
  }

  public async list(groupId: string, query: ConversationQuery): Promise<ConversationMessage[]> {
    await this.options.schema.ensure();
    const where = ["group_id = ?", "sent_at_ms >= ?", "sent_at_ms <= ?"];
    const params: SqlValue[] = [groupId, query.sinceMs, query.untilMs ?? Number.MAX_SAFE_INTEGER];
    if (query.text?.trim()) {
      where.push("(body LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(query.text.trim())}%`;
      params.push(pattern, pattern);
    }
    const limit = Math.max(1, Math.min(Math.trunc(query.limit), 1_000));
    const result = await this.options.db.query<Row>(
      `SELECT message_id, author, body, from_bot, sent_at_ms FROM conversation_messages
       WHERE ${where.join(" AND ")}
       ORDER BY sent_at_ms DESC, id DESC LIMIT ${limit}`,
      params,
    );
    return result.results.reverse().map(rowToMessage);
  }

  public async hasHumanMessages(groupId: string, sinceMs: number, untilMs: number): Promise<boolean> {
    await this.options.schema.ensure();
    const result = await this.options.db.query(
      `SELECT 1 AS found FROM conversation_messages
       WHERE group_id = ? AND from_bot = 0 AND sent_at_ms >= ? AND sent_at_ms <= ? LIMIT 1`,
      [groupId, sinceMs, untilMs],
    );
    return result.results.length > 0;
  }

  public async activeGroups(sinceMs: number): Promise<string[]> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<{ group_id: string }>(
      `SELECT DISTINCT group_id FROM conversation_messages
       WHERE from_bot = 0 AND sent_at_ms >= ? ORDER BY group_id`,
      [sinceMs],
    );
    return result.results.map((row) => row.group_id);
  }

  public async prune(olderThanMs: number): Promise<number> {
    await this.options.schema.ensure();
    const result = await this.options.db.query(
      "DELETE FROM conversation_messages WHERE sent_at_ms < ?",
      [olderThanMs],
    );
    return result.changes;
  }
}

/**
 * One-time move of the local SQLite history into D1. Copies everything still
 * within retention, then clears the local table so nothing is stored twice.
 * Safe to re-run: D1 dedupes on message id.
 */
export async function moveLocalConversationToD1(input: {
  local: Pick<ConversationStore, "exportSince" | "clear">;
  d1: Pick<ConversationLog, "record">;
  sinceMs: number;
  logger: Logger;
}): Promise<number> {
  const messages = input.local.exportSince(input.sinceMs);
  for (const message of messages) await input.d1.record(message);
  const cleared = input.local.clear();
  if (messages.length > 0 || cleared > 0) {
    input.logger.info(
      { copied: messages.length, clearedLocally: cleared },
      "Moved the conversation log from local SQLite into D1",
    );
  }
  return messages.length;
}
