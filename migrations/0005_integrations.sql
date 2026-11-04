-- Captain Patch Phase 3: the outbound actions ledger. Every Gmail draft (E<id>)
-- and calendar proposal (EV<id>) is recorded here, and it changes to sent or
-- booked only after a founder's explicit "send E<id>" / "book EV<id>". Patch
-- runs these idempotent statements on first use; to create them ahead of time:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/0005_integrations.sql

CREATE TABLE IF NOT EXISTS outbound_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'calendar')),
  status TEXT NOT NULL
    CHECK (status IN ('drafted', 'sent', 'proposed', 'booked', 'cancelled')),
  group_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  external_id TEXT,
  created_by TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  executed_by TEXT,
  executed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS outbound_actions_lookup ON outbound_actions (group_id, kind, status, id);
