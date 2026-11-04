-- Captain Patch: people, their setup interview and how each of them writes.
-- people: one row per person on the allowlist who has talked to Patch, with
--   their profile, the synthesized voice guide and setup progress.
-- person_ids: every WhatsApp sender id (@lid and @c.us forms) of a person.
-- person_notes: the evidence the voice guide is built from: interview
--   answers, writing samples, rules the person gave, lessons from the final
--   versions they sent, and observations from their group messages.
-- Patch runs these idempotent statements on first use; to create them ahead of time:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/0008_people.sql

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  role TEXT,
  focus TEXT,
  about TEXT,
  voice TEXT,
  voice_stale INTEGER NOT NULL DEFAULT 0,
  voice_updated_at TEXT,
  observed_until_ms INTEGER NOT NULL DEFAULT 0,
  setup_status TEXT NOT NULL DEFAULT 'none'
    CHECK (setup_status IN ('none', 'active', 'paused', 'done')),
  setup_step INTEGER NOT NULL DEFAULT 0,
  setup_follow_up TEXT,
  setup_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_ids (
  sender_id TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS person_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('answer', 'sample', 'rule', 'lesson', 'observation')),
  topic TEXT,
  content TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS person_notes_lookup ON person_notes (person_id, kind, id);
