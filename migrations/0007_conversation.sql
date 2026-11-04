-- Captain Patch: the group conversation log in D1 (moved from local SQLite
-- once the Patch API Worker exists). Patch runs these idempotent statements on
-- startup; to create them ahead of time:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/0007_conversation.sql

CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  from_bot INTEGER NOT NULL DEFAULT 0,
  sent_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS conversation_group_time ON conversation_messages (group_id, sent_at_ms);
