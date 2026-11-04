-- Captain Patch Phase 1: long-term memory, follow-ups, recurring tasks,
-- task checklists and a shared audit trail. A memory with owner_id 0 is
-- shared with the group; otherwise it is private to that person (people.id).
-- Patch runs these idempotent
-- statements on startup; to create them ahead of time:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/0002_phase1.sql

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('decision', 'commitment', 'fact', 'person', 'preference')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  source_author TEXT,
  source_message_id TEXT,
  observed_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  owner_id INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_id, owner_id, kind, subject, content)
);

CREATE INDEX IF NOT EXISTS memories_lookup ON memories (group_id, deleted_at, kind, observed_at);

CREATE INDEX IF NOT EXISTS memories_owner ON memories (owner_id, deleted_at, observed_at);

CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  promise TEXT NOT NULL,
  due_at TEXT,
  due_ts INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  notes TEXT,
  created_by TEXT NOT NULL,
  source_group TEXT,
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (source_message_id, promise)
);

CREATE INDEX IF NOT EXISTS follow_ups_open ON follow_ups (status, due_ts);

CREATE TABLE IF NOT EXISTS recurring_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT,
  owner TEXT,
  area TEXT,
  priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  every INTEGER NOT NULL DEFAULT 1,
  weekday INTEGER CHECK (weekday BETWEEN 1 AND 7),
  day_of_month INTEGER CHECK (day_of_month BETWEEN 1 AND 31),
  next_run_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS recurring_due ON recurring_tasks (active, deleted_at, next_run_on);

CREATE TABLE IF NOT EXISTS task_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, position)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_entity ON audit_events (entity, entity_id, id);
