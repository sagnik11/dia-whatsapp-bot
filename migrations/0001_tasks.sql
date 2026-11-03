-- Captain Patch task list in Cloudflare D1.
-- Patch runs these idempotent statements on startup, so applying them by hand
-- is optional. To create the tables ahead of time:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/0001_tasks.sql

CREATE TABLE IF NOT EXISTS tasks (
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
);

CREATE INDEX IF NOT EXISTS tasks_open_due ON tasks (deleted_at, status, due_ts);

CREATE INDEX IF NOT EXISTS tasks_owner ON tasks (deleted_at, owner);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  actor TEXT NOT NULL,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, id);
