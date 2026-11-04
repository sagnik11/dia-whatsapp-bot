-- Captain Patch Phase 3 platform: high-water marks for syncing long-term
-- memories and tasks into Vectorize (one row per source: memory, task).
-- Patch runs this idempotent statement when semantic sync first runs; to
-- create it ahead of time:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/0006_platform.sql

CREATE TABLE IF NOT EXISTS vector_sync_state (
  source TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
