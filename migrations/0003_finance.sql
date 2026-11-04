-- Captain Patch Phase 2 (money): subscription radar and monthly budgets.
-- Spends stay in the Notion Daily Spend Log; these tables hold only what the
-- spend log cannot. Patch runs these idempotent statements on startup; to
-- create them ahead of time:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/0003_finance.sql

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor TEXT NOT NULL,
  plan TEXT,
  amount_inr REAL NOT NULL CHECK (amount_inr >= 0),
  cycle TEXT NOT NULL CHECK (cycle IN ('monthly', 'quarterly', 'yearly')),
  renews_on TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  notes TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS subscriptions_renewal ON subscriptions (deleted_at, status, renews_on);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_inr REAL NOT NULL CHECK (amount_inr >= 0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (month, category)
);

-- Same as 0002_phase1.sql; repeated so finance audits work on their own.
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
