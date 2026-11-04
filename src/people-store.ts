import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import { recordAudit, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";

/** Keep in sync with migrations/0008_people.sql (a test enforces this). */
export const PEOPLE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS people (
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
)`,
  `CREATE TABLE IF NOT EXISTS person_ids (
  sender_id TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS person_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('answer', 'sample', 'rule', 'lesson', 'observation')),
  topic TEXT,
  content TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS person_notes_lookup ON person_notes (person_id, kind, id)",
];

export type SetupStatus = "none" | "active" | "paused" | "done";
export type NoteKind = "answer" | "sample" | "rule" | "lesson" | "observation";

export interface Person {
  id: number;
  name: string;
  aliases: string[];
  role: string | null;
  focus: string | null;
  about: string | null;
  voice: string | null;
  voiceStale: boolean;
  voiceUpdatedAt: string | null;
  observedUntilMs: number;
  setup: { status: SetupStatus; step: number; followUp: string | null; updatedAt: string | null };
  createdAt: string;
  updatedAt: string;
}

export interface PersonNote {
  id: number;
  personId: number;
  kind: NoteKind;
  topic: string | null;
  content: string;
  sourceMessageId: string | null;
  createdAt: string;
}

interface PersonRow {
  id: number;
  name: string;
  aliases: string;
  role: string | null;
  focus: string | null;
  about: string | null;
  voice: string | null;
  voice_stale: number;
  voice_updated_at: string | null;
  observed_until_ms: number;
  setup_status: SetupStatus;
  setup_step: number;
  setup_follow_up: string | null;
  setup_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface NoteRow {
  id: number;
  person_id: number;
  kind: NoteKind;
  topic: string | null;
  content: string;
  source_message_id: string | null;
  created_at: string;
}

const PERSON_COLUMNS =
  "id, name, aliases, role, focus, about, voice, voice_stale, voice_updated_at, observed_until_ms, setup_status, setup_step, setup_follow_up, setup_updated_at, created_at, updated_at";
const NOTE_COLUMNS = "id, person_id, kind, topic, content, source_message_id, created_at";
export const MAX_NOTE_CHARACTERS = 6_000;
const MAX_FIELD_CHARACTERS = 600;

function parseList(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toPerson(row: PersonRow): Person {
  return {
    id: Number(row.id),
    name: row.name,
    aliases: parseList(row.aliases),
    role: row.role,
    focus: row.focus,
    about: row.about,
    voice: row.voice,
    voiceStale: Number(row.voice_stale) === 1,
    voiceUpdatedAt: row.voice_updated_at,
    observedUntilMs: Number(row.observed_until_ms),
    setup: {
      status: row.setup_status,
      step: Number(row.setup_step),
      followUp: row.setup_follow_up,
      updatedAt: row.setup_updated_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNote(row: NoteRow): PersonNote {
  return {
    id: Number(row.id),
    personId: Number(row.person_id),
    kind: row.kind,
    topic: row.topic,
    content: row.content,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
  };
}

/** Lower-case, accent-free, single-spaced: how names are compared. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

interface PeopleStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  logger: Logger;
  now?: () => Date;
}

/**
 * Everyone on the allowlist who has talked to Patch: who they are, how they
 * write, and their setup interview. A person is found by any of their
 * WhatsApp sender ids (`@lid` and `@c.us` forms) or by name.
 */
export class PeopleStore {
  public constructor(private readonly options: PeopleStoreOptions) {}

  public async list(): Promise<Person[]> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<PersonRow>(`SELECT ${PERSON_COLUMNS} FROM people ORDER BY id`);
    return result.results.map(toPerson);
  }

  public async get(id: number): Promise<Person | null> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<PersonRow>(`SELECT ${PERSON_COLUMNS} FROM people WHERE id = ?`, [id]);
    const row = result.results[0];
    return row ? toPerson(row) : null;
  }

  public async findBySender(senderIds: readonly string[]): Promise<Person | null> {
    const ids = [...new Set(senderIds.filter(Boolean))];
    if (ids.length === 0) return null;
    await this.options.schema.ensure();
    const result = await this.options.db.query<PersonRow>(
      `SELECT ${PERSON_COLUMNS} FROM people WHERE id IN
         (SELECT person_id FROM person_ids WHERE sender_id IN (${placeholders(ids.length)}))
       ORDER BY id LIMIT 1`,
      ids,
    );
    const row = result.results[0];
    return row ? toPerson(row) : null;
  }

  /** Exact name or alias first, then a unique first-name match ("Tanvi" for "Tanvi Sharma"). */
  public async findByName(name: string): Promise<Person | null> {
    const wanted = normalizeName(name);
    if (!wanted) return null;
    const people = await this.list();
    const names = (person: Person) => [person.name, ...person.aliases].map(normalizeName);
    const exact = people.find((person) => names(person).includes(wanted));
    if (exact) return exact;
    const first = people.filter((person) => names(person).some((known) => known.split(" ")[0] === wanted));
    return first.length === 1 ? (first[0] ?? null) : null;
  }

  /**
   * The person behind these sender ids, created on first contact. New ids and
   * a changed WhatsApp name are added, so later lookups by either still work.
   */
  public async ensure(input: { name: string; senderIds: readonly string[] }): Promise<Person> {
    await this.options.schema.ensure();
    const name = input.name.trim().slice(0, 100) || "Unknown member";
    const now = this.nowIso();
    let person = await this.findBySender(input.senderIds);
    if (!person) {
      const created = await this.options.db.query<{ id: number }>(
        `INSERT INTO people (name, aliases, created_at, updated_at) VALUES (?, '[]', ?, ?) RETURNING id`,
        [name, now, now],
      );
      const id = Number(created.results[0]?.id);
      await recordAudit(this.options.db, this.options.logger, { entity: "person", entityId: id, action: "created", actor: name, changes: { name } }, now);
      person = await this.get(id);
      if (!person) throw new Error("Could not create the person record");
    } else if (normalizeName(person.name) !== normalizeName(name) && !person.aliases.map(normalizeName).includes(normalizeName(name))) {
      const aliases = [...person.aliases, name].slice(-10);
      await this.options.db.query("UPDATE people SET aliases = ?, updated_at = ? WHERE id = ?", [JSON.stringify(aliases), now, person.id]);
      person = { ...person, aliases };
    }
    for (const senderId of new Set(input.senderIds.filter(Boolean))) {
      await this.options.db.query(
        "INSERT INTO person_ids (sender_id, person_id) VALUES (?, ?) ON CONFLICT (sender_id) DO NOTHING",
        [senderId, person.id],
      );
    }
    return person;
  }

  public async setSetup(
    personId: number,
    setup: { status: SetupStatus; step: number; followUp: string | null },
  ): Promise<void> {
    await this.options.schema.ensure();
    const now = this.nowIso();
    await this.options.db.query(
      `UPDATE people SET setup_status = ?, setup_step = ?, setup_follow_up = ?, setup_updated_at = ?, updated_at = ?
       WHERE id = ?`,
      [setup.status, setup.step, setup.followUp, now, now, personId],
    );
  }

  public async setProfile(
    personId: number,
    fields: { role?: string | null; focus?: string | null; about?: string | null },
    actor: string,
  ): Promise<void> {
    await this.options.schema.ensure();
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const key of ["role", "focus", "about"] as const) {
      const value = fields[key];
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      params.push(value === null ? null : value.trim().slice(0, MAX_FIELD_CHARACTERS) || null);
    }
    if (sets.length === 0) return;
    const now = this.nowIso();
    await this.options.db.query(`UPDATE people SET ${sets.join(", ")}, voice_stale = 1, updated_at = ? WHERE id = ?`, [
      ...params,
      now,
      personId,
    ]);
    await recordAudit(this.options.db, this.options.logger, { entity: "person", entityId: personId, action: "profile_updated", actor, changes: fields }, now);
  }

  public async setVoice(personId: number, voice: string, about: string | null): Promise<void> {
    await this.options.schema.ensure();
    const now = this.nowIso();
    await this.options.db.query(
      `UPDATE people SET voice = ?, about = COALESCE(?, about), voice_stale = 0, voice_updated_at = ?, updated_at = ?
       WHERE id = ?`,
      [voice.slice(0, 3_000), about?.slice(0, MAX_FIELD_CHARACTERS) ?? null, now, now, personId],
    );
  }

  public async setObservedUntil(personId: number, untilMs: number): Promise<void> {
    await this.options.schema.ensure();
    await this.options.db.query("UPDATE people SET observed_until_ms = MAX(observed_until_ms, ?) WHERE id = ?", [
      untilMs,
      personId,
    ]);
  }

  public async addNote(
    personId: number,
    note: { kind: NoteKind; topic: string | null; content: string; sourceMessageId: string | null },
  ): Promise<PersonNote> {
    await this.options.schema.ensure();
    const now = this.nowIso();
    const result = await this.options.db.query<NoteRow>(
      `INSERT INTO person_notes (person_id, kind, topic, content, source_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING ${NOTE_COLUMNS}`,
      [personId, note.kind, note.topic, note.content.trim().slice(0, MAX_NOTE_CHARACTERS), note.sourceMessageId, now],
    );
    if (note.kind !== "observation") {
      await this.options.db.query("UPDATE people SET voice_stale = 1, updated_at = ? WHERE id = ?", [now, personId]);
    }
    const row = result.results[0];
    if (!row) throw new Error("Could not save the note");
    return toNote(row);
  }

  /** An interview answer or setup sample: answering the same question again replaces it. */
  public async replaceNote(
    personId: number,
    note: { kind: NoteKind; topic: string; content: string; sourceMessageId: string | null },
  ): Promise<PersonNote> {
    await this.options.schema.ensure();
    await this.options.db.query("DELETE FROM person_notes WHERE person_id = ? AND kind = ? AND topic = ?", [
      personId,
      note.kind,
      note.topic,
    ]);
    return this.addNote(personId, note);
  }

  public async notes(personId: number, kinds?: readonly NoteKind[]): Promise<PersonNote[]> {
    await this.options.schema.ensure();
    const filter = kinds && kinds.length > 0 ? ` AND kind IN (${placeholders(kinds.length)})` : "";
    const result = await this.options.db.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM person_notes WHERE person_id = ?${filter} ORDER BY id`,
      [personId, ...(kinds ?? [])],
    );
    return result.results.map(toNote);
  }

  /** Deletes only this person's rules and lessons with these ids; returns the ones removed. */
  public async deleteRules(personId: number, ids: readonly number[], actor: string): Promise<PersonNote[]> {
    if (ids.length === 0) return [];
    await this.options.schema.ensure();
    const found = await this.options.db.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS} FROM person_notes
       WHERE person_id = ? AND kind IN ('rule', 'lesson') AND id IN (${placeholders(ids.length)})`,
      [personId, ...ids],
    );
    const notes = found.results.map(toNote);
    if (notes.length === 0) return [];
    const now = this.nowIso();
    await this.options.db.query(`DELETE FROM person_notes WHERE id IN (${placeholders(notes.length)})`, notes.map((note) => note.id));
    await this.options.db.query("UPDATE people SET voice_stale = 1, updated_at = ? WHERE id = ?", [now, personId]);
    await recordAudit(this.options.db, this.options.logger, { entity: "person", entityId: personId, action: "rules_deleted", actor, changes: { notes } }, now);
    return notes;
  }

  /** Keeps the newest `keep` notes of one kind (optionally one topic prefix). */
  public async prune(personId: number, kind: NoteKind, keep: number, topicPrefix?: string): Promise<void> {
    await this.options.schema.ensure();
    const topicFilter = topicPrefix ? " AND topic LIKE ?" : "";
    const params: SqlValue[] = [personId, kind, ...(topicPrefix ? [`${topicPrefix}%`] : [])];
    await this.options.db.query(
      `DELETE FROM person_notes WHERE person_id = ? AND kind = ?${topicFilter} AND id NOT IN
         (SELECT id FROM person_notes WHERE person_id = ? AND kind = ?${topicFilter} ORDER BY id DESC LIMIT ${Math.max(0, Math.trunc(keep))})`,
      [...params, ...params],
    );
  }

  /** Erases the person, their sender ids and every note. */
  public async remove(personId: number, actor: string): Promise<void> {
    await this.options.schema.ensure();
    await this.options.db.query("DELETE FROM person_notes WHERE person_id = ?", [personId]);
    await this.options.db.query("DELETE FROM person_ids WHERE person_id = ?", [personId]);
    await this.options.db.query("DELETE FROM people WHERE id = ?", [personId]);
    await recordAudit(this.options.db, this.options.logger, { entity: "person", entityId: personId, action: "deleted", actor, changes: {} }, this.nowIso());
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
