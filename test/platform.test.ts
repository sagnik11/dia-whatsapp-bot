import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiLike,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1Value,
  Env,
  R2BucketLike,
  VectorQueryOptions,
  VectorRecord,
  VectorizeIndexLike,
} from "../worker/src/bindings.js";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  constantTimeEqual,
  handleRequest,
  parseFileKey,
} from "../worker/src/index.js";
import { SemanticTools, isSemanticRequest } from "../src/assistant-semantic.js";
import { DiaAssistant } from "../src/assistant.js";
import { WhatsAppBot } from "../src/bot.js";
import { D1QueryError } from "../src/cloudflare-d1.js";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "../src/d1-schema.js";
import type { CompletionRequest, CompletionResult } from "../src/llm.js";
import { MemoryStore } from "../src/memory-store.js";
import {
  FileArchive,
  PatchApiSqlExecutor,
  SemanticIndex,
  attachmentArchiveKey,
  createAttachmentArchiver,
} from "../src/patch-api-client.js";
import { ProactiveScheduler } from "../src/scheduler.js";
import { TaskStore, type TaskCreateInput } from "../src/task-store.js";
import type { AssistantAttachment } from "../src/types.js";
import { PLATFORM_SCHEMA_STATEMENTS, VectorSyncJob } from "../src/vector-sync.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const TOKEN = "patch-test-token-0123456789";
const BASE_URL = "https://patch-api.test/";

// --- Fake Cloudflare bindings -------------------------------------------------------

function fakeD1(database: DatabaseSync): D1DatabaseLike & { prepared: string[] } {
  const prepared: string[] = [];
  const statement = (sql: string, params: readonly D1Value[]): D1PreparedStatementLike => ({
    bind: (...values) => statement(sql, values),
    all: async () => {
      const values = params.map((value) => (typeof value === "boolean" ? Number(value) : value)) as SQLInputValue[];
      const compiled = database.prepare(sql);
      if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
        const rows = compiled.all(...values) as Array<Record<string, unknown>>;
        return { success: true, results: rows, meta: { changes: rows.length, last_row_id: 0 } };
      }
      const result = compiled.run(...values);
      return {
        success: true,
        results: [],
        meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
      };
    },
  });
  return {
    prepared,
    prepare: (sql) => {
      prepared.push(sql);
      return statement(sql, []);
    },
  };
}

/** Deterministic bag-of-words embedding: texts sharing words point the same way. */
function embed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    vector[hash % EMBEDDING_DIMENSIONS] = (vector[hash % EMBEDDING_DIMENSIONS] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

function fakeAi(): AiLike & { calls: Array<{ model: string; texts: string[]; options: unknown }> } {
  const calls: Array<{ model: string; texts: string[]; options: unknown }> = [];
  return {
    calls,
    run: async (model, inputs, options) => {
      const texts = inputs.text as string[];
      calls.push({ model, texts, options });
      return { shape: [texts.length, EMBEDDING_DIMENSIONS], data: texts.map(embed), pooling: "cls" };
    },
  };
}

function matchesFilter(metadata: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = metadata[key];
    const operators = condition as { $in?: unknown[]; $eq?: unknown };
    if (operators.$in) return operators.$in.includes(value);
    if ("$eq" in operators) return value === operators.$eq;
    throw new Error(`Unsupported filter on ${key}`);
  });
}

function fakeVectorize(options: { ignoreFilter?: boolean } = {}): VectorizeIndexLike & {
  vectors: Map<string, VectorRecord>;
  queries: VectorQueryOptions[];
} {
  const vectors = new Map<string, VectorRecord>();
  const queries: VectorQueryOptions[] = [];
  return {
    vectors,
    queries,
    upsert: async (records) => {
      for (const record of records) vectors.set(record.id, record);
      return { mutationId: `mutation-${vectors.size}` };
    },
    query: async (vector, query) => {
      queries.push(query);
      const matches = [...vectors.values()]
        .filter((record) => options.ignoreFilter || matchesFilter(record.metadata, query.filter))
        .map((record) => ({
          id: record.id,
          score: record.values.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0),
          metadata: query.returnMetadata === "all" ? record.metadata : null,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, query.topK);
      return { matches };
    },
  };
}

function fakeR2(): R2BucketLike & { objects: Map<string, { data: Uint8Array; contentType: string }> } {
  const objects = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    objects,
    put: async (key, value, options) => {
      const data = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { data, contentType: options.httpMetadata.contentType ?? "application/octet-stream" });
      return { key, size: data.byteLength, etag: "etag-1", httpEtag: '"etag-1"' };
    },
    get: async (key) => {
      const object = objects.get(key);
      if (!object) return null;
      return {
        key,
        size: object.data.byteLength,
        etag: "etag-1",
        httpEtag: '"etag-1"',
        httpMetadata: { contentType: object.contentType },
        body: new Response(new Uint8Array(object.data)).body as ReadableStream,
      };
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
}

let databases: Array<{ close(): void }> = [];
afterEach(() => {
  for (const database of databases) database.close();
  databases = [];
});

function workerEnv(options: { ignoreFilter?: boolean; token?: string } = {}) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const env = {
    DB: fakeD1(database),
    VECTORS: fakeVectorize(options),
    FILES: fakeR2(),
    AI: fakeAi(),
    PATCH_API_TOKEN: options.token ?? TOKEN,
    AI_GATEWAY_ID: "patch-gateway",
  } satisfies Env;
  return env;
}

/** A fetch that delivers requests straight to the Worker, as the network would. */
function workerFetch(env: Env) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handleRequest(new Request(input, init), env),
  );
}

function call(env: Env, path: string, init: RequestInit = {}, token: string | null = TOKEN) {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return handleRequest(new Request(new URL(path, BASE_URL), { ...init, headers }), env);
}

function postJson(env: Env, path: string, body: unknown, token: string | null = TOKEN) {
  return call(env, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, token);
}

// --- Worker -------------------------------------------------------------------------

describe("Patch API Worker", () => {
  it("refuses every route without the exact bearer token", async () => {
    const env = workerEnv();
    for (const token of [null, "", "wrong-token", `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const response = await postJson(env, "/d1/query", { sql: "SELECT 1", params: [] }, token);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ success: false, errors: [{ message: "Missing or invalid bearer token" }] });
    }
    expect((await call(env, "/files/a.txt", { method: "GET" }, "nope")).status).toBe(401);
    expect((await call(env, "/nowhere", { method: "GET" }, null)).status).toBe(401);
    expect(env.DB.prepared).toEqual([]);
    expect(env.AI.calls).toEqual([]);

    const unconfigured = workerEnv({ token: " " });
    expect((await postJson(unconfigured, "/d1/query", { sql: "SELECT 1" }, " ")).status).toBe(500);
    expect((await call(env, "/nowhere")).status).toBe(404);
    expect((await call(env, "/d1/query", { method: "GET" })).status).toBe(405);
  });

  it("compares tokens in constant time over digests", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("abc", "abcdef")).toBe(false);
  });

  it("answers /d1/query in D1's REST shape", async () => {
    const env = workerEnv();
    await postJson(env, "/d1/query", { sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, done INTEGER)" });
    const insert = await postJson(env, "/d1/query", { sql: "INSERT INTO notes (body, done) VALUES (?, ?)", params: ["Ship it", true] });
    expect(await insert.json()).toEqual({
      success: true,
      errors: [],
      messages: [],
      result: [
        {
          success: true,
          results: [],
          meta: { changes: 1, last_row_id: 1, duration: 0, rows_read: 0, rows_written: 0 },
        },
      ],
    });
    const select = await postJson(env, "/d1/query", { sql: "SELECT id, body, done FROM notes WHERE id = ?", params: [1] });
    expect(((await select.json()) as { result: Array<{ results: unknown[] }> }).result[0]?.results).toEqual([
      { id: 1, body: "Ship it", done: 1 },
    ]);

    const missing = await postJson(env, "/d1/query", { sql: "SELECT * FROM nope" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ success: false, result: null, errors: [{ code: 7500 }] });
    expect((await postJson(env, "/d1/query", { sql: "SELECT ?", params: [{ x: 1 }] })).status).toBe(400);
    expect((await postJson(env, "/d1/query", { params: [] })).status).toBe(400);
    const notJson = await call(env, "/d1/query", { method: "POST", body: "{nope" });
    expect(notJson.status).toBe(400);
  });

  it("embeds in batches through AI Gateway and upserts idempotently", async () => {
    const env = workerEnv();
    const items = Array.from({ length: 60 }, (_, index) => ({
      id: `memory:${index + 1}`,
      text: `fact number ${index + 1}`,
      metadata: { group_id: "g1", kind: "memory", ref: `M${index + 1}` },
    }));
    const response = await postJson(env, "/vectors/upsert", { items });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, result: { upserted: 60 } });
    expect(env.AI.calls.map((c) => [c.model, c.texts.length, c.options])).toEqual([
      [EMBEDDING_MODEL, 50, { gateway: { id: "patch-gateway" } }],
      [EMBEDDING_MODEL, 10, { gateway: { id: "patch-gateway" } }],
    ]);
    await postJson(env, "/vectors/upsert", { items: items.slice(0, 5) });
    expect(env.VECTORS.vectors.size).toBe(60);

    const bad = await postJson(env, "/vectors/upsert", {
      items: [{ id: "memory:1", text: "x", metadata: { kind: "memory", ref: "M1" } }],
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ errors: [{ message: "items[0].metadata.group_id must be a non-empty string" }] });
    expect((await postJson(env, "/vectors/upsert", { items: [] })).status).toBe(400);
  });

  it("always scopes /vectors/query to one group plus company-wide items", async () => {
    const env = workerEnv();
    await postJson(env, "/vectors/upsert", {
      items: [
        { id: "memory:1", text: "SOC 2 audit starts in January", metadata: { group_id: "g1", kind: "memory", ref: "M1" } },
        { id: "memory:2", text: "SOC 2 secret from the other group", metadata: { group_id: "g2", kind: "memory", ref: "M2" } },
        { id: "task:1", text: "Task: book the SOC 2 auditor", metadata: { group_id: "*", kind: "task", ref: "#1" } },
      ],
    });
    const response = await postJson(env, "/vectors/query", { text: "SOC 2", group_id: "g1", topK: 10 });
    const body = (await response.json()) as { result: { matches: Array<{ id: string; metadata: { ref: string } }> } };
    expect(body.result.matches.map((m) => m.id).sort()).toEqual(["memory:1", "task:1"]);
    expect(env.VECTORS.queries[0]).toEqual({
      topK: 10,
      filter: { group_id: { $in: ["g1", "*"] } },
      returnMetadata: "all",
      returnValues: false,
    });

    const memoriesOnly = await postJson(env, "/vectors/query", { text: "SOC 2", group_id: "g1", kind: "memory" });
    expect(((await memoriesOnly.json()) as typeof body).result.matches.map((m) => m.id)).toEqual(["memory:1"]);
    expect(env.VECTORS.queries[1]?.filter).toEqual({ group_id: { $in: ["g1", "*"] }, kind: { $eq: "memory" } });

    expect((await postJson(env, "/vectors/query", { text: "SOC 2" })).status).toBe(400);
    expect((await postJson(env, "/vectors/query", { text: "SOC 2", group_id: "g1", topK: 500 })).status).toBe(400);
  });

  it("drops other groups' matches even if the index ignores the filter", async () => {
    const env = workerEnv({ ignoreFilter: true });
    await postJson(env, "/vectors/upsert", {
      items: [
        { id: "memory:1", text: "pricing per repo", metadata: { group_id: "g1", kind: "memory", ref: "M1" } },
        { id: "memory:2", text: "pricing secret", metadata: { group_id: "g2", kind: "memory", ref: "M2" } },
      ],
    });
    const response = await postJson(env, "/vectors/query", { text: "pricing", group_id: "g1" });
    const body = (await response.json()) as { result: { matches: Array<{ id: string }> } };
    expect(body.result.matches.map((m) => m.id)).toEqual(["memory:1"]);
  });

  it("streams files to R2 and back, and rejects unsafe keys", async () => {
    const env = workerEnv();
    const put = await call(env, "/files/g1%40g.us/2026/11/m1-invoice.pdf", {
      method: "PUT",
      headers: { "content-type": "application/pdf", "content-length": "3" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(put.status).toBe(201);
    expect(env.FILES.objects.get("g1@g.us/2026/11/m1-invoice.pdf")?.contentType).toBe("application/pdf");

    const get = await call(env, "/files/g1@g.us/2026/11/m1-invoice.pdf");
    expect(get.headers.get("content-type")).toBe("application/pdf");
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await call(env, "/files/g1@g.us/2026/11/m1-invoice.pdf", { method: "DELETE" })).status).toBe(204);
    expect((await call(env, "/files/g1@g.us/2026/11/m1-invoice.pdf")).status).toBe(404);

    expect((await call(env, "/files/a.txt", { method: "PUT", body: "hi" })).status).toBe(411);
    expect((await call(env, "/files/a.txt", { method: "POST" })).status).toBe(405);
    expect(parseFileKey("/files/a/../b")).toBeNull();
    expect(parseFileKey("/files/a//b")).toBeNull();
    expect(parseFileKey("/files/a%2F..%2Fb")).toBeNull();
    expect(parseFileKey("/files/%E0%A4%A")).toBeNull();
    expect(parseFileKey("/files/g1@g.us/2026/11/x.pdf")).toBe("g1@g.us/2026/11/x.pdf");
  });
});

// --- Bot-side clients ---------------------------------------------------------------

function draft(title: string, notes: string | null = null): TaskCreateInput {
  return { title, notes, status: null, priority: null, owner: null, area: null, dueAt: null, tags: [] };
}

describe("PatchApiSqlExecutor", () => {
  it("runs the real stores through the Worker's D1 binding", async () => {
    const env = workerEnv();
    const fetchMock = workerFetch(env);
    const db = new PatchApiSqlExecutor({ baseUrl: BASE_URL, token: TOKEN, fetch: fetchMock as typeof fetch, logger });
    const schema = new SchemaGate(db, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
    const memory = new MemoryStore({ db, schema, logger });
    const tasks = new TaskStore({ db, timezone: "Asia/Kolkata", logger });

    const { added } = await memory.add(
      "g1",
      [{ kind: "decision", subject: "pricing", content: "We price per repo.", sourceAuthor: "Tanvi", sourceMessageId: "m1", observedAt: "2026-11-03T10:00:00.000Z" }],
      "Tanvi",
    );
    expect(added.map((m) => m.id)).toEqual([1]);
    expect((await memory.search("g1", { text: "repo", kind: null, sinceIso: null, limit: 5 })).map((m) => m.content)).toEqual([
      "We price per repo.",
    ]);
    const [created] = await tasks.create([draft("Book the SOC 2 auditor")], { actor: "Sagnik", groupName: "HQ", messageId: "m2" });
    expect(created?.task).toMatchObject({ id: 1, title: "Book the SOC 2 auditor", status: "todo" });
    expect(await db.query("UPDATE tasks SET owner = ? WHERE id = ?", ["Tanvi", 1])).toMatchObject({ changes: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://patch-api.test/d1/query");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("surfaces Worker refusals and SQL errors as D1QueryError", async () => {
    const env = workerEnv();
    const wrongToken = new PatchApiSqlExecutor({ baseUrl: BASE_URL, token: "nope", fetch: workerFetch(env) as typeof fetch, logger });
    await expect(wrongToken.query("SELECT 1")).rejects.toThrow(new D1QueryError("D1 query failed (401): Missing or invalid bearer token", 401));
    const db = new PatchApiSqlExecutor({ baseUrl: BASE_URL, token: TOKEN, fetch: workerFetch(env) as typeof fetch, logger });
    await expect(db.query("SELECT * FROM missing_table")).rejects.toMatchObject({ name: "D1QueryError", status: 400 });
  });
});

// --- Vector sync --------------------------------------------------------------------

function syncFixture() {
  const executor = createSqliteExecutor();
  databases.push(executor);
  const env = workerEnv();
  const index = new SemanticIndex({ baseUrl: BASE_URL, token: TOKEN, fetch: workerFetch(env) as typeof fetch, logger });
  const upsert = vi.spyOn(index, "upsert");
  const schema = new SchemaGate(executor, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
  const memory = new MemoryStore({ db: executor, schema, logger });
  const tasks = new TaskStore({ db: executor, timezone: "Asia/Kolkata", logger });
  const job = new VectorSyncJob({ db: executor, index, logger, batchSize: 2 });
  return { executor, env, index, upsert, memory, tasks, job };
}

const memoryEntry = (subject: string, content: string) => ({
  kind: "fact" as const,
  subject,
  content,
  sourceAuthor: "Tanvi",
  sourceMessageId: null,
  observedAt: "2026-11-03T10:00:00.000Z",
});

describe("VectorSyncJob", () => {
  it("matches the checked-in D1 migration", () => {
    const migration = readFileSync(new URL("../migrations/0006_platform.sql", import.meta.url), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual(PLATFORM_SCHEMA_STATEMENTS.map((s) => s.replace(/\s+/g, " ").trim()));
  });

  it("indexes each new memory and task once and advances the high-water mark", async () => {
    const { env, upsert, memory, tasks, job } = syncFixture();
    await memory.add("g1", [memoryEntry("SOC 2", "Audit starts in January."), memoryEntry("Acme", "Rahul runs procurement.")], "Tanvi");
    await memory.add("g2", [memoryEntry("SOC 2", "Other group's note.")], "Sagnik");
    await tasks.create([draft("Book the SOC 2 auditor"), draft("Pay AWS"), draft("Oops")], { actor: "Sagnik", groupName: null, messageId: "m" });
    await tasks.delete(3, "Sagnik");

    expect(await job.syncAll()).toEqual({ memory: 3, task: 2 });
    expect(await job.lastId("memory")).toBe(3);
    expect(await job.lastId("task")).toBe(2);
    expect([...env.VECTORS.vectors.keys()].sort()).toEqual(["memory:1", "memory:2", "memory:3", "task:1", "task:2"]);
    expect(env.VECTORS.vectors.get("memory:3")?.metadata).toMatchObject({ group_id: "g2", kind: "memory", ref: "M3", memory_kind: "fact" });
    expect(env.VECTORS.vectors.get("task:1")?.metadata).toEqual({ group_id: "*", kind: "task", ref: "#1", title: "Book the SOC 2 auditor" });
    expect(upsert).toHaveBeenCalledTimes(3); // memories 2 + 1, tasks 2

    upsert.mockClear();
    expect(await job.syncAll()).toEqual({ memory: 0, task: 0 });
    expect(upsert).not.toHaveBeenCalled();

    await memory.add("g1", [memoryEntry("pricing", "We price per repo.")], "Tanvi");
    expect(await job.syncAll()).toEqual({ memory: 1, task: 0 });
    expect(upsert.mock.calls[0]?.[0].map((item) => item.id)).toEqual(["memory:4"]);
  });

  it("is idempotent after a lost mark and never advances past a failed upsert", async () => {
    const { executor, env, upsert, memory, job } = syncFixture();
    await memory.add("g1", [memoryEntry("a", "first"), memoryEntry("b", "second")], "Tanvi");
    await job.syncAll();
    await executor.query("DELETE FROM vector_sync_state");
    expect(await job.syncAll()).toEqual({ memory: 2, task: 0 });
    expect(env.VECTORS.vectors.size).toBe(2);

    await memory.add("g1", [memoryEntry("c", "third")], "Tanvi");
    upsert.mockRejectedValueOnce(new Error("Worker down"));
    expect(await job.syncAll()).toEqual({ memory: 0, task: 0 });
    expect(await job.lastId("memory")).toBe(2);
    expect(await job.syncAll()).toEqual({ memory: 1, task: 0 });
    expect(await job.lastId("memory")).toBe(3);
  });

  it("runs from the scheduler's jobs without sending anything", async () => {
    const { upsert, memory, job } = syncFixture();
    await memory.add("g1", [memoryEntry("a", "first")], "Tanvi");
    const send = vi.fn();
    const scheduler = new ProactiveScheduler({
      reminders: { due: vi.fn().mockReturnValue([]) } as never,
      tasks: { listOpen: vi.fn() },
      timezone: "Asia/Kolkata",
      logger,
      jobs: [job],
    });
    await scheduler.runOnce(Date.parse("2026-11-04T06:30:00.000Z"), send);
    expect(job.intervalMs).toBe(600_000);
    expect(upsert).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});

// --- semantic_search ----------------------------------------------------------------

async function semanticFixture() {
  const fixture = syncFixture();
  await fixture.memory.add(
    "g1",
    [
      { ...memoryEntry("SOC 2", "SOC 2 Type I audit starts in January."), kind: "decision" as const },
      memoryEntry("lunch", "Tanvi prefers dosa."),
    ],
    "Tanvi",
  );
  await fixture.memory.add("g2", [memoryEntry("SOC 2", "Other group SOC 2 secret.")], "Sagnik");
  await fixture.tasks.create([draft("Book the SOC 2 auditor", "Ask Rahul for referrals")], { actor: "Sagnik", groupName: null, messageId: "m" });
  await fixture.job.syncAll();
  const semantic = new SemanticTools({ index: fixture.index, db: fixture.executor, logger });
  return { ...fixture, semantic };
}

const request = (body: string) => ({
  groupId: "g1",
  groupName: "HQ",
  messageId: "msg",
  requestedBy: "Sagnik",
  requestedById: "s@c.us",
  body,
  quotedMessage: null,
  recentContext: [],
});

function scripted(...turns: CompletionResult[]) {
  const requests: CompletionRequest[] = [];
  const complete = vi.fn(async (completion: CompletionRequest) => {
    requests.push({ ...completion, messages: [...completion.messages] });
    const next = turns.shift();
    if (!next) throw new Error("out of turns");
    return next;
  });
  return { complete, requests };
}

describe("semantic_search tool", () => {
  it("detects conceptual questions", () => {
    expect(isSemanticRequest("@patch what have we said about SOC 2?")).toBe(true);
    expect(isSemanticRequest("anything on enterprise security?")).toBe(true);
    expect(isSemanticRequest("add a task to pay AWS")).toBe(false);
  });

  it("answers from this group's memories and company tasks with citable refs", async () => {
    const { semantic, tasks, env } = await semanticFixture();
    const llm = scripted(
      toolTurn("s1", "semantic_search", { query: "SOC 2", kinds: ["Memory", "task"] }),
      textTurn("We start the SOC 2 Type I audit in January (M1); #1 books the auditor."),
    );
    const bot = new DiaAssistant({ llm, botName: "Patch", timezone: "Asia/Kolkata", tasks, modules: [semantic], logger });

    expect(await bot.respond(request("@patch what have we said about SOC 2?"))).toBe(
      "We start the SOC 2 Type I audit in January (M1); #1 books the auditor.",
    );
    expect(llm.requests[0]?.toolChoice).toBe("required");
    expect(llm.requests[0]?.tools?.map((tool) => tool.name)).toContain("semantic_search");
    const toolOutput = llm.requests[1]?.messages.find((message) => message.role === "tool");
    const payload = JSON.parse(String(toolOutput?.content)) as { matches: Array<Record<string, unknown>> };
    expect(payload.matches.slice(0, 2).map((match) => match.ref).sort()).toEqual(["#1", "M1"]);
    expect(payload.matches.find((match) => match.ref === "M1")).toMatchObject({
      type: "memory",
      kind: "decision",
      content: "SOC 2 Type I audit starts in January.",
      saidBy: "Tanvi",
    });
    expect(payload.matches.find((match) => match.ref === "#1")).toMatchObject({ type: "task", title: "Book the SOC 2 auditor", status: "todo" });
    expect(JSON.stringify(payload)).not.toContain("Other group");
    expect(env.VECTORS.queries.at(-1)?.filter).toEqual({ group_id: { $in: ["g1", "*"] } });
  });

  it("re-reads matches from D1, so forgotten memories and other groups never surface", async () => {
    const { semantic, memory, index } = await semanticFixture();
    await memory.forget("g1", 1, "Sagnik");
    // Even if the index returned another group's memory, D1 hydration drops it.
    vi.spyOn(index, "query").mockResolvedValueOnce([
      { id: "memory:1", score: 0.9, metadata: {} },
      { id: "memory:3", score: 0.8, metadata: {} },
      { id: "task:1", score: 0.7, metadata: {} },
      { id: "junk", score: 0.6, metadata: {} },
    ]);
    const known = new Set<number>();
    const outcome = await semantic.search({ query: "SOC 2", kinds: ["memory", "task"] }, request("q"), known);
    expect(outcome).toMatchObject({ kind: "output", payload: { count: 1, matches: [{ ref: "#1" }] } });
    expect(known).toEqual(new Set([1]));

    const memoriesOnly = await semantic.search({ query: "lunch", kinds: ["memory"] }, request("q"), new Set());
    expect(memoriesOnly).toMatchObject({ payload: { matches: [{ ref: "M2", subject: "lunch" }] } });
  });

  it("tells the model to fall back when the Worker is unavailable", async () => {
    const { semantic, index } = await semanticFixture();
    vi.spyOn(index, "query").mockRejectedValueOnce(new Error("Patch API down"));
    expect(await semantic.search({ query: "SOC 2" }, request("q"), new Set())).toEqual({
      kind: "output",
      payload: { error: "Semantic search is unavailable right now. Use search_memory and list_tasks instead." },
    });
  });
});

// --- Attachment archive -------------------------------------------------------------

const pdf: AssistantAttachment = {
  kind: "pdf",
  mimeType: "application/pdf",
  fileName: "Q3 invoice (final).pdf",
  dataBase64: Buffer.from("%PDF-1.7").toString("base64"),
  sizeBytes: 8,
  transcript: null,
};

describe("attachment archive", () => {
  it("builds keys as <groupId>/<YYYY>/<MM>/<messageId>-<fileName> in the founders' month", () => {
    expect(
      attachmentArchiveKey({
        groupId: "120363@g.us",
        messageId: "false_120363@g.us_3EB0/AB",
        fileName: "Q3 invoice (final).pdf",
        sentAtMs: Date.parse("2026-10-31T20:00:00.000Z"), // 1 Nov, 01:30 IST
        timezone: "Asia/Kolkata",
      }),
    ).toBe("120363@g.us/2026/11/false_120363@g.us_3EB0_AB-Q3_invoice_final_.pdf");
    expect(
      attachmentArchiveKey({ groupId: "g", messageId: "m", fileName: "../../etc", sentAtMs: 0, timezone: "UTC" }),
    ).toBe("g/1970/01/m-__.._etc");
  });

  it("round-trips files through the Worker and R2", async () => {
    const env = workerEnv();
    const archive = new FileArchive({ baseUrl: BASE_URL, token: TOKEN, fetch: workerFetch(env) as typeof fetch, logger });
    const archiveAttachment = createAttachmentArchiver(archive, "Asia/Kolkata");
    const key = await archiveAttachment({
      groupId: "120363@g.us",
      messageId: "false_120363@g.us_ABC",
      sentAtMs: Date.parse("2026-11-04T06:30:00.000Z"),
      attachment: pdf,
    });
    expect(key).toBe("120363@g.us/2026/11/false_120363@g.us_ABC-Q3_invoice_final_.pdf");
    expect(env.FILES.objects.get(key)?.contentType).toBe("application/pdf");

    const stored = await archive.get(key);
    expect(Buffer.from(stored?.data ?? []).toString()).toBe("%PDF-1.7");
    expect(stored?.contentType).toBe("application/pdf");
    await archive.delete(key);
    expect(await archive.get(key)).toBeNull();

    const refused = new FileArchive({ baseUrl: BASE_URL, token: "nope", fetch: workerFetch(env) as typeof fetch, logger });
    await expect(refused.put("a.txt", new Uint8Array([1]), "text/plain")).rejects.toMatchObject({ status: 401 });
  });

  it("archives an ingested attachment from the bot and logs its key", async () => {
    class FakeClient extends EventEmitter {
      public readonly info = { wid: { _serialized: "bot@c.us" } };
      public readonly sendMessage = vi.fn(async () => ({ id: { _serialized: "reply-1" } }));
      public readonly initialize = vi.fn(async () => void this.emit("ready"));
    }
    const client = new FakeClient();
    const record = vi.fn();
    const archiveAttachment = vi.fn(async () => "g1@g.us/2026/11/msg-1-Q3_invoice_final_.pdf");
    const respond = vi.fn(async () => "Filed it.");
    const bot = new WhatsAppBot({
      assistant: { respond } as never,
      context: { add: vi.fn(), get: vi.fn().mockReturnValue([]) } as never,
      dedupe: { claim: vi.fn().mockReturnValue(true) } as never,
      allowedGroupIds: new Set(["g1@g.us"]),
      authorizedUserIds: new Set(["s@c.us"]),
      unauthorizedReply: "Shoo.",
      botName: "Patch",
      botTrigger: "@patch",
      dataDir: ".data",
      listGroupsOnStart: false,
      mediaIngestion: { ingest: vi.fn(async () => pdf) } as never,
      conversation: { record },
      archiveAttachment,
      client: client as never,
      logger,
    });
    await bot.start();

    client.emit("message_create", {
      id: { _serialized: "msg-1" },
      from: "g1@g.us",
      to: "bot@c.us",
      fromMe: false,
      author: "s@c.us",
      body: "@patch file this invoice",
      type: "document",
      hasMedia: true,
      hasQuotedMsg: false,
      timestamp: 1_793_000_000,
      mentionedIds: [],
      getContact: async () => ({ pushname: "Sagnik", id: { _serialized: "s@c.us" }, number: "s" }),
      getChat: async () => ({ name: "HQ" }),
      downloadMedia: async () => ({ mimetype: "application/pdf", data: pdf.dataBase64, filename: pdf.fileName, filesize: 8 }),
    });

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith("g1@g.us", "Filed it."));
    await vi.waitFor(() =>
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          groupId: "g1@g.us",
          messageId: "msg-1:archive",
          author: "Patch",
          body: "📎 Archived Q3 invoice (final).pdf as g1@g.us/2026/11/msg-1-Q3_invoice_final_.pdf",
          fromBot: true,
        }),
      ),
    );
    expect(archiveAttachment).toHaveBeenCalledWith({
      groupId: "g1@g.us",
      messageId: "msg-1",
      sentAtMs: 1_793_000_000_000,
      attachment: pdf,
    });
  });
});
