-- Captain Patch Phase 3 platform: semantic memory sync.
-- vector_sync_cursor holds one cursor per source (memory, memory_deleted,
-- task, message), advanced only after Vectorize accepted a batch.
-- brain_dump_chunks holds the Notion Brain Dump notes that are in Vectorize,
-- keyed by a hash of their heading and text, so search can show them and
-- removed notes can be deleted from the index.
-- Patch runs these idempotent statements when semantic sync first runs; to
-- create them ahead of time:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/0006_platform.sql

CREATE TABLE IF NOT EXISTS vector_sync_cursor (
  source TEXT PRIMARY KEY,
  mark TEXT NOT NULL DEFAULT '',
  last_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brain_dump_chunks (
  chunk_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
