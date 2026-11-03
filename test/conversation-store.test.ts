import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "../src/conversation-store.js";

let store: ConversationStore | undefined;

function createStore(): ConversationStore {
  store = new ConversationStore(":memory:");
  return store;
}

afterEach(() => {
  store?.close();
  store = undefined;
});

const base = Date.parse("2026-11-04T04:00:00.000Z");

function say(
  target: ConversationStore,
  id: string,
  author: string,
  body: string,
  minutes: number,
  fromBot = false,
  groupId = "group@g.us",
): void {
  target.record({ groupId, messageId: id, author, body, fromBot, sentAtMs: base + minutes * 60_000 });
}

describe("ConversationStore", () => {
  it("keeps one group's messages in order and ignores repeated deliveries", () => {
    const conversation = createStore();
    say(conversation, "m1", "Sagnik", "Let's price per repo", 0);
    say(conversation, "m2", "Tanvi", "Agreed, I'll update the deck by Friday", 5);
    say(conversation, "m2", "Tanvi", "duplicate delivery", 5);
    say(conversation, "other", "Rahul", "different group", 6, false, "other@g.us");
    say(conversation, "empty", "Tanvi", "   ", 7);

    expect(
      conversation.list("group@g.us", { sinceMs: base, limit: 50 }).map((m) => [m.author, m.body]),
    ).toEqual([
      ["Sagnik", "Let's price per repo"],
      ["Tanvi", "Agreed, I'll update the deck by Friday"],
    ]);
  });

  it("attributes Patch's replies to Patch whichever copy arrives first", () => {
    const conversation = createStore();
    // WhatsApp echoes the bot's own message before sendMessage resolves...
    say(conversation, "r1", "Autter Bot", "✅ Task #4 added", 1);
    say(conversation, "r1", "Captain Patch", "✅ Task #4 added", 1, true);
    // ...or after it.
    say(conversation, "r2", "Captain Patch", "✅ Task #5 added", 2, true);
    say(conversation, "r2", "Autter Bot", "✅ Task #5 added", 2);

    expect(
      conversation.list("group@g.us", { sinceMs: base, limit: 50 }).map((m) => [m.author, m.fromBot]),
    ).toEqual([
      ["Captain Patch", true],
      ["Captain Patch", true],
    ]);
  });

  it("filters by window and text, keeping the newest messages when over the limit", () => {
    const conversation = createStore();
    say(conversation, "a", "Sagnik", "pricing idea one", 0);
    say(conversation, "b", "Tanvi", "lunch?", 10);
    say(conversation, "c", "Sagnik", "pricing idea two", 20);
    say(conversation, "d", "Tanvi", "pricing final", 30);

    expect(
      conversation
        .list("group@g.us", { sinceMs: base, text: "pricing", limit: 2 })
        .map((m) => m.body),
    ).toEqual(["pricing idea two", "pricing final"]);
    expect(
      conversation
        .list("group@g.us", { sinceMs: base + 5 * 60_000, untilMs: base + 15 * 60_000, limit: 10 })
        .map((m) => m.body),
    ).toEqual(["lunch?"]);
  });

  it("only counts founders' messages as news and prunes past the retention cutoff", () => {
    const conversation = createStore();
    say(conversation, "bot", "Captain Patch", "⏰ Reminder", 0, true);
    expect(conversation.hasHumanMessages("group@g.us", base, base + 60 * 60_000)).toBe(false);
    say(conversation, "human", "Tanvi", "shipping today", 30);
    expect(conversation.hasHumanMessages("group@g.us", base, base + 60 * 60_000)).toBe(true);

    expect(conversation.prune(base + 10 * 60_000)).toBe(1);
    expect(conversation.list("group@g.us", { sinceMs: 0, limit: 10 }).map((m) => m.messageId)).toEqual([
      "human",
    ]);
  });
});
