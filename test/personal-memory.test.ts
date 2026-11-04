import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Phase1Tools } from "../src/assistant-phase1.js";
import { SemanticTools } from "../src/assistant-semantic.js";
import { EVERYONE, isAuthorizedSender } from "../src/authorization.js";
import { ChecklistStore } from "../src/checklist-store.js";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "../src/d1-schema.js";
import { FollowUpStore } from "../src/follow-up-store.js";
import { distillGroupMemory } from "../src/memory-distiller.js";
import { MemoryStore, type MemoryInput, type MemoryViewer } from "../src/memory-store.js";
import { PEOPLE_SCHEMA_STATEMENTS, PeopleStore } from "../src/people-store.js";
import { RecurringTaskStore } from "../src/recurring-store.js";
import { TaskStore } from "../src/task-store.js";
import type { AssistantRequest } from "../src/types.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function fixture() {
  const db = createSqliteExecutor();
  cleanups.push(() => db.close());
  const schema = new SchemaGate(db, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
  const memory = new MemoryStore({ db, schema, logger });
  const people = new PeopleStore({ db, schema: new SchemaGate(db, PEOPLE_SCHEMA_STATEMENTS, logger, "People"), logger });
  const sagnik = await people.ensure({ name: "Sagnik", senderIds: ["s@c.us"] });
  const tanvi = await people.ensure({ name: "Tanvi", senderIds: ["t@c.us"] });
  const tasks = new TaskStore({ db, timezone: "Asia/Kolkata", logger });
  const phase1 = new Phase1Tools(
    {
      memory,
      followUps: new FollowUpStore({ db, schema, timezone: "Asia/Kolkata", logger }),
      recurring: new RecurringTaskStore({ db, schema, timezone: "Asia/Kolkata", logger }),
      checklists: new ChecklistStore({ db, schema, logger }),
      people,
    },
    tasks,
    "Asia/Kolkata",
    logger,
  );
  return { db, memory, people, sagnik, tanvi, phase1 };
}

const entry = (subject: string, content: string, extra: Partial<MemoryInput> = {}): MemoryInput => ({
  kind: "fact",
  subject,
  content,
  sourceAuthor: "Sagnik",
  sourceMessageId: null,
  observedAt: "2026-11-04T10:00:00.000Z",
  ...extra,
});

function request(from: "Sagnik" | "Tanvi", body: string, groupId = "g1@g.us"): AssistantRequest {
  return {
    groupId,
    groupName: "HQ",
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    requestedBy: from,
    requestedById: from === "Sagnik" ? "s@c.us" : "t@c.us",
    body,
    quotedMessage: null,
    recentContext: [],
  };
}

describe("open access", () => {
  it("lets everyone in an allowed group in with *, and only listed ids otherwise", () => {
    expect(isAuthorizedSender(new Set([EVERYONE]), ["anyone@lid"])).toBe(true);
    expect(isAuthorizedSender(new Set(["s@c.us"]), ["anyone@lid"])).toBe(false);
    expect(isAuthorizedSender(new Set(), ["s@c.us"])).toBe(false);
  });

  it("documents * in the env example", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(example).toContain("AUTHORIZED_USER_IDS=*");
    expect(example).toContain("MEDIA_MAX_BYTES=25000000");
  });
});

describe("personal and shared memory", () => {
  it("shows the group's shared memory plus only the viewer's own private memory, from any group", async () => {
    const { memory, sagnik, tanvi } = await fixture();
    await memory.add("g1@g.us", [entry("pricing", "We price per repo.")], "Sagnik");
    await memory.add("g1@g.us", [entry("coffee", "Sagnik takes his coffee black.", { kind: "preference", ownerId: sagnik.id })], "Sagnik");
    await memory.add("g2@g.us", [entry("gym", "Sagnik trains at 7am.", { kind: "preference", ownerId: sagnik.id })], "Sagnik");
    await memory.add("g1@g.us", [entry("deck", "Tanvi owes Asha the deck by Friday.", { kind: "commitment", sourceAuthor: "Tanvi", ownerId: tanvi.id })], "Tanvi");
    // The same words can be both shared and someone's private note.
    await memory.add("g1@g.us", [entry("pricing", "We price per repo.", { ownerId: tanvi.id })], "Tanvi");

    const query = { text: null, kind: null, sinceIso: null, limit: 20 } as const;
    const subjects = async (viewer?: MemoryViewer) =>
      (await memory.search("g1@g.us", viewer ? { ...query, viewer } : query)).map((item) => `${item.subject}:${item.ownerId}`).sort();

    expect(await subjects()).toEqual(["pricing:0"]);
    expect(await subjects({ scope: "person", personId: sagnik.id })).toEqual([`coffee:${sagnik.id}`, `gym:${sagnik.id}`, "pricing:0"]);
    expect(await subjects({ scope: "person", personId: tanvi.id })).toEqual([`deck:${tanvi.id}`, "pricing:0", `pricing:${tanvi.id}`]);
    expect(await subjects({ scope: "all" })).toHaveLength(4);

    // Tanvi cannot forget Sagnik's private memory, but can forget a shared one.
    const coffee = (await memory.search("g1@g.us", { ...query, text: "coffee", viewer: { scope: "person", personId: sagnik.id } }))[0];
    expect(await memory.forget("g1@g.us", coffee?.id ?? 0, "Tanvi", { scope: "person", personId: tanvi.id })).toBeNull();
    expect(await memory.forget("g1@g.us", coffee?.id ?? 0, "Sagnik", { scope: "person", personId: sagnik.id })).not.toBeNull();
  });

  it("remembers privately by default, decisions and 'for everyone' items as shared", async () => {
    const { phase1, sagnik } = await fixture();
    const sagnikSession = phase1.begin(request("Sagnik", "remember I prefer calls after 4pm"), new Set());
    expect(await sagnikSession.handle("remember", { kind: "preference", subject: "calls", content: "Sagnik prefers calls after 4pm." })).toMatchObject({
      kind: "final",
      text: "🧠 Remembered for you only (M1, preference): Sagnik prefers calls after 4pm.",
    });
    expect(await sagnikSession.handle("remember", { kind: "decision", subject: "pricing", content: "We price per repo." })).toMatchObject({
      text: "🧠 Decision logged for everyone (M2, decision): We price per repo.",
    });
    expect(await sagnikSession.handle("remember", { scope: "Shared", kind: "fact", subject: "office", content: "The office wifi password changes monthly." })).toMatchObject({
      text: expect.stringContaining("for everyone (M3, fact)"),
    });

    const tanviSession = phase1.begin(request("Tanvi", "what do we know?"), new Set());
    const seen = await tanviSession.handle("search_memory", {});
    expect(seen).toMatchObject({ kind: "output", payload: { count: 2 } });
    expect(JSON.stringify(seen)).not.toContain("4pm");
    // Tanvi cannot forget it even by naming it.
    const sneaky = phase1.begin(request("Tanvi", "forget M1"), new Set());
    expect(await sneaky.handle("forget_memory", { memory_id: 1 })).toMatchObject({ text: "⚠️ M1 is not in this group's memory or yours." });

    const mine = await phase1.begin(request("Sagnik", "what do you know about me?", "g2@g.us"), new Set()).handle("search_memory", { text: "calls" });
    expect(mine).toMatchObject({ payload: { count: 1, memories: [{ ref: "M1", personal: true }] } });
    expect(sagnik.id).toBeGreaterThan(0);
  });

  it("files distilled commitments and preferences under the speaker, and the rest as shared", async () => {
    const { memory, people, tanvi } = await fixture();
    const conversation = {
      list: vi.fn(async () => [
        { messageId: "a", author: "Tanvi", body: "I'll send Asha the deck by Friday", fromBot: false, sentAt: "2026-11-04T10:00:00.000Z" },
      ]),
    };
    const distiller = {
      distill: vi.fn(async () => [
        entry("deck", "Tanvi will send Asha the deck by Friday.", { kind: "commitment", sourceAuthor: "Tanvi" }),
        entry("pricing", "The team decided to price per repo.", { kind: "decision", sourceAuthor: "Tanvi" }),
        entry("lunch", "Rahul prefers lunch meetings.", { kind: "preference", sourceAuthor: "Rahul" }),
      ]),
    };
    const added = await distillGroupMemory({ groupId: "g1@g.us", sinceMs: 0, untilMs: Date.now(), conversation, memory, distiller, people });
    expect(added).toBe(3);
    const all = await memory.search("g1@g.us", { text: null, kind: null, sinceIso: null, limit: 10, viewer: { scope: "all" } });
    expect(Object.fromEntries(all.map((item) => [item.subject, item.ownerId]))).toEqual({ deck: tanvi.id, pricing: 0, lunch: 0 });
  });

  it("never lets semantic search surface someone else's private memory", async () => {
    const { db, memory, people, sagnik } = await fixture();
    await memory.add("g1@g.us", [entry("soc2", "SOC 2 audit starts in January.")], "Sagnik");
    await memory.add("g1@g.us", [entry("soc2 notes", "Sagnik thinks the SOC 2 auditor is overpriced.", { ownerId: sagnik.id })], "Sagnik");
    const index = { query: vi.fn(async () => [
      { id: "memory:1", score: 0.9, metadata: {} },
      { id: "memory:2", score: 0.8, metadata: {} },
    ]) };
    const semantic = new SemanticTools({ index, db, logger, people });
    const asTanvi = await semantic.search({ query: "SOC 2" }, request("Tanvi", "q"), new Set());
    expect(asTanvi).toMatchObject({ payload: { count: 1, matches: [{ ref: "M1" }] } });
    const asSagnik = await semantic.search({ query: "SOC 2" }, request("Sagnik", "q"), new Set());
    expect(asSagnik).toMatchObject({ payload: { count: 2 } });
  });
});
