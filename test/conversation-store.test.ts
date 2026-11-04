import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationStore, type ConversationLog } from "../src/conversation-store.js";
import {
  CONVERSATION_SCHEMA_STATEMENTS,
  D1ConversationStore,
  moveLocalConversationToD1,
} from "../src/conversation-store-d1.js";
import { SchemaGate } from "../src/d1-schema.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn() } as never;
const base = Date.parse("2026-11-04T04:00:00.000Z");
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function localStore(): ConversationLog {
  const store = new ConversationStore(":memory:");
  cleanups.push(() => store.close());
  return store;
}

function d1Store(): ConversationLog {
  const executor = createSqliteExecutor();
  cleanups.push(() => executor.close());
  const schema = new SchemaGate(executor, CONVERSATION_SCHEMA_STATEMENTS, logger, "Conversation");
  return new D1ConversationStore({ db: executor, schema, logger });
}

async function say(
  target: ConversationLog,
  id: string,
  author: string,
  body: string,
  minutes: number,
  fromBot = false,
  groupId = "group@g.us",
): Promise<void> {
  await target.record({ groupId, messageId: id, author, body, fromBot, sentAtMs: base + minutes * 60_000 });
}

describe.each([
  ["local SQLite", localStore],
  ["Cloudflare D1", d1Store],
])("conversation log in %s", (_name, create) => {
  it("keeps one group's messages in order and ignores repeated deliveries", async () => {
    const conversation = create();
    await say(conversation, "m1", "Sagnik", "Let's price per repo", 0);
    await say(conversation, "m2", "Tanvi", "Agreed, I'll update the deck by Friday", 5);
    await say(conversation, "m2", "Tanvi", "duplicate delivery", 5);
    await say(conversation, "other", "Rahul", "different group", 6, false, "other@g.us");
    await say(conversation, "empty", "Tanvi", "   ", 7);

    const messages = await conversation.list("group@g.us", { sinceMs: base, limit: 50 });
    expect(messages.map((m) => [m.author, m.body])).toEqual([
      ["Sagnik", "Let's price per repo"],
      ["Tanvi", "Agreed, I'll update the deck by Friday"],
    ]);
  });

  it("attributes Patch's replies to Patch whichever copy arrives first", async () => {
    const conversation = create();
    await say(conversation, "r1", "Autter Bot", "✅ Task #4 added", 1);
    await say(conversation, "r1", "Captain Patch", "✅ Task #4 added", 1, true);
    await say(conversation, "r2", "Captain Patch", "✅ Task #5 added", 2, true);
    await say(conversation, "r2", "Autter Bot", "✅ Task #5 added", 2);

    const messages = await conversation.list("group@g.us", { sinceMs: base, limit: 50 });
    expect(messages.map((m) => [m.author, m.fromBot])).toEqual([
      ["Captain Patch", true],
      ["Captain Patch", true],
    ]);
  });

  it("filters by window and text, keeping the newest messages when over the limit", async () => {
    const conversation = create();
    await say(conversation, "a", "Sagnik", "pricing idea one", 0);
    await say(conversation, "b", "Tanvi", "lunch?", 10);
    await say(conversation, "c", "Sagnik", "pricing idea two", 20);
    await say(conversation, "d", "Tanvi", "pricing final", 30);

    const priced = await conversation.list("group@g.us", { sinceMs: base, text: "pricing", limit: 2 });
    expect(priced.map((m) => m.body)).toEqual(["pricing idea two", "pricing final"]);
    const windowed = await conversation.list("group@g.us", {
      sinceMs: base + 5 * 60_000,
      untilMs: base + 15 * 60_000,
      limit: 10,
    });
    expect(windowed.map((m) => m.body)).toEqual(["lunch?"]);
  });

  it("only counts founders' messages as news, lists active groups, and prunes", async () => {
    const conversation = create();
    await say(conversation, "bot", "Captain Patch", "⏰ Reminder", 0, true);
    expect(await conversation.hasHumanMessages("group@g.us", base, base + 3_600_000)).toBe(false);
    expect(await conversation.activeGroups(base)).toEqual([]);
    await say(conversation, "human", "Tanvi", "shipping today", 30);
    expect(await conversation.hasHumanMessages("group@g.us", base, base + 3_600_000)).toBe(true);
    expect(await conversation.activeGroups(base)).toEqual(["group@g.us"]);

    expect(await conversation.prune(base + 10 * 60_000)).toBe(1);
    const left = await conversation.list("group@g.us", { sinceMs: 0, limit: 10 });
    expect(left.map((m) => m.messageId)).toEqual(["human"]);
  });
});

describe("moving the conversation log to D1", () => {
  it("copies history within retention once, then clears the local copy", async () => {
    const local = new ConversationStore(":memory:");
    cleanups.push(() => local.close());
    const d1 = d1Store();
    await say(local, "old", "Sagnik", "too old to keep", -10_000);
    await say(local, "m1", "Tanvi", "Decided: price per repo", 0);
    await say(local, "r1", "Captain Patch", "🧠 Decision logged", 1, true);

    const copied = await moveLocalConversationToD1({ local, d1, sinceMs: base - 60_000, logger });
    expect(copied).toBe(2);
    expect((await d1.list("group@g.us", { sinceMs: 0, limit: 10 })).map((m) => [m.body, m.fromBot])).toEqual([
      ["Decided: price per repo", false],
      ["🧠 Decision logged", true],
    ]);
    expect(await local.list("group@g.us", { sinceMs: 0, limit: 10 })).toEqual([]);
    expect(await moveLocalConversationToD1({ local, d1, sinceMs: 0, logger })).toBe(0);
  });

  it("matches the checked-in D1 migration", () => {
    const migration = readFileSync(new URL("../migrations/0007_conversation.sql", import.meta.url), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual(CONVERSATION_SCHEMA_STATEMENTS.map((s) => s.replace(/\s+/g, " ").trim()));
  });
});
