import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Phase1Tools, isPhase1Request, referencedPhase1Ids } from "../src/assistant-phase1.js";
import { DiaAssistant } from "../src/assistant.js";
import { ChecklistStore } from "../src/checklist-store.js";
import { ConversationStore } from "../src/conversation-store.js";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "../src/d1-schema.js";
import { FollowUpStore } from "../src/follow-up-store.js";
import type { CompletionRequest, CompletionResult } from "../src/llm.js";
import { MemoryDistiller, distillGroupMemory, extractJsonObject } from "../src/memory-distiller.js";
import { MemoryStore } from "../src/memory-store.js";
import {
  RecurringTaskStore,
  firstRunOn,
  materializeRecurringTasks,
  nextRunAfter,
} from "../src/recurring-store.js";
import { ProactiveScheduler } from "../src/scheduler.js";
import { TaskStore, type TaskCreateInput } from "../src/task-store.js";
import { nextWeeklyRunAt } from "../src/time.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const NOW = "2026-11-04T06:30:00.000Z"; // Wednesday, 12:00 IST

let executor: ReturnType<typeof createSqliteExecutor> | undefined;
afterEach(() => {
  executor?.close();
  executor = undefined;
});

function services(now = NOW) {
  executor = createSqliteExecutor();
  const clock = () => new Date(now);
  const schema = new SchemaGate(executor, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
  const tasks = new TaskStore({ db: executor, timezone: "Asia/Kolkata", logger, now: clock });
  return {
    db: executor,
    tasks,
    memory: new MemoryStore({ db: executor, schema, logger, now: clock }),
    followUps: new FollowUpStore({ db: executor, schema, timezone: "Asia/Kolkata", logger, now: clock }),
    recurring: new RecurringTaskStore({ db: executor, schema, timezone: "Asia/Kolkata", logger, now: clock }),
    checklists: new ChecklistStore({ db: executor, schema, logger, now: clock }),
  };
}

function draft(title: string): TaskCreateInput {
  return { title, notes: null, status: null, priority: null, owner: null, area: null, dueAt: null, tags: [] };
}

describe("Phase 1 schema", () => {
  it("matches the checked-in D1 migration", () => {
    const migration = readFileSync(new URL("../migrations/0002_phase1.sql", import.meta.url), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual(PHASE1_SCHEMA_STATEMENTS.map((s) => s.replace(/\s+/g, " ").trim()));
  });
});

describe("MemoryStore", () => {
  it("dedupes, searches by every word, keeps groups apart, and soft-forgets", async () => {
    const { memory } = services();
    const entry = {
      kind: "decision" as const,
      subject: "pricing",
      content: "We price per repo, starting December 2026.",
      sourceAuthor: "Tanvi",
      sourceMessageId: "m1",
      observedAt: "2026-11-03T10:00:00.000Z",
    };
    const first = await memory.add("g1", [entry], "Patch (memory)");
    const again = await memory.add("g1", [entry], "Patch (memory)");
    await memory.add("g2", [{ ...entry, content: "Other group secret pricing" }], "Patch (memory)");
    expect(first.added).toHaveLength(1);
    expect(again).toEqual({ added: [], duplicates: 1 });

    const found = await memory.search("g1", { text: "price December", kind: null, sinceIso: null, limit: 10 });
    expect(found.map((m) => m.content)).toEqual(["We price per repo, starting December 2026."]);
    expect(await memory.search("g1", { text: "secret", kind: null, sinceIso: null, limit: 10 })).toEqual([]);

    const id = first.added[0]?.id ?? 0;
    expect(await memory.forget("g2", id, "Sagnik")).toBeNull();
    expect((await memory.forget("g1", id, "Sagnik"))?.subject).toBe("pricing");
    expect(await memory.search("g1", { text: null, kind: null, sinceIso: null, limit: 10 })).toEqual([]);
  });
});

describe("MemoryDistiller", () => {
  const conversation = [
    { messageId: "a", author: "Tanvi", body: "Decided: pilot pricing is ₹40k/month", fromBot: false, sentAt: "2026-11-04T05:00:00.000Z" },
    { messageId: "b", author: "Captain Patch", body: "✅ Task #3 added", fromBot: true, sentAt: "2026-11-04T05:01:00.000Z" },
  ];

  it("keeps memories tied to founder messages and drops ones pinned on Patch", async () => {
    const complete = vi.fn().mockResolvedValue(
      textTurn(
        '```json\n{"memories":[{"kind":"decision","subject":"pilot pricing","content":"Pilot pricing is ₹40k/month (decided 4 Nov 2026).","ref":0},{"kind":"fact","subject":"tasks","content":"Task 3 exists","ref":1}]}\n```',
      ),
    );
    const distiller = new MemoryDistiller({ llm: { complete }, timezone: "Asia/Kolkata", reasoningEffort: "high", logger });
    const memories = await distiller.distill(conversation, []);
    expect(memories).toEqual([
      {
        kind: "decision",
        subject: "pilot pricing",
        content: "Pilot pricing is ₹40k/month (decided 4 Nov 2026).",
        sourceAuthor: "Tanvi",
        sourceMessageId: "a",
        observedAt: "2026-11-04T05:00:00.000Z",
      },
    ]);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ reasoningEffort: "high", metadata: { feature: "memory_distill" } });
  });

  it("stores nothing when the reply is not JSON, and skips quiet windows entirely", async () => {
    expect(extractJsonObject("no json here")).toBeNull();
    const { memory } = services();
    const store = new ConversationStore(":memory:");
    store.record({ groupId: "g1", messageId: "bot", author: "Captain Patch", body: "⏰", fromBot: true, sentAtMs: 1 });
    const distill = vi.fn();
    expect(
      await distillGroupMemory({ groupId: "g1", sinceMs: 0, untilMs: 10, conversation: store, memory, distiller: { distill } }),
    ).toBe(0);
    expect(distill).not.toHaveBeenCalled();
    store.close();
  });
});

describe("recurrence math", () => {
  const weekly = { frequency: "weekly" as const, every: 1, weekday: 1, dayOfMonth: null };
  const monthly = { frequency: "monthly" as const, every: 1, weekday: null, dayOfMonth: 31 };

  it("finds the first matching day and the following runs", () => {
    expect(firstRunOn(weekly, "2026-11-04")).toBe("2026-11-09"); // Wed → next Monday
    expect(firstRunOn(weekly, "2026-11-09")).toBe("2026-11-09");
    expect(nextRunAfter({ ...weekly, every: 2 }, "2026-11-09")).toBe("2026-11-23");
    expect(firstRunOn(monthly, "2026-11-04")).toBe("2026-11-30"); // clamped to 30 days
    expect(nextRunAfter(monthly, "2026-11-30")).toBe("2026-12-31");
    expect(nextRunAfter(monthly, "2027-01-31")).toBe("2027-02-28");
    expect(nextRunAfter({ ...monthly, every: 3 }, "2026-11-30")).toBe("2027-02-28");
  });

  it("adds each run's task once and moves the template past today", async () => {
    const { recurring, tasks } = services("2026-11-09T04:00:00.000Z"); // Monday 09:30 IST
    const template = await recurring.create(
      { title: "Send pipeline update", notes: null, owner: "Tanvi", area: "Sales", priority: "high", rule: weekly, startsOn: null },
      "Sagnik",
    );
    expect(template.nextRunOn).toBe("2026-11-09");

    const nowMs = Date.parse("2026-11-09T04:00:00.000Z");
    expect(await materializeRecurringTasks({ recurring, tasks, timezone: "Asia/Kolkata", nowMs, logger })).toBe(1);
    expect(await materializeRecurringTasks({ recurring, tasks, timezone: "Asia/Kolkata", nowMs, logger })).toBe(0);
    const open = await tasks.listOpen();
    expect(open.tasks.map((t) => [t.title, t.dueAt, t.owner, t.tags])).toEqual([
      ["Send pipeline update", "2026-11-09", "Tanvi", ["recurring"]],
    ]);
    expect((await recurring.list())[0]?.nextRunOn).toBe("2026-11-16");
  });
});

describe("FollowUpStore and ChecklistStore", () => {
  it("tracks, lists by due date, closes follow-ups, and ticks checklist items", async () => {
    const { followUps, checklists, tasks } = services();
    const [created] = await followUps.create(
      [{ owner: "Sagnik", counterparty: "Rahul (Acme)", promise: "Send the pilot proposal", dueAt: "2026-11-06", notes: null }],
      { actor: "Sagnik", groupName: "HQ", messageId: "m1" },
    );
    expect(created?.followUp).toMatchObject({ id: 1, status: "open" });
    expect((await followUps.list({ statuses: null, owner: null, counterparty: "acme", dueTo: "2026-11-07", limit: 10 })).length).toBe(1);
    const closed = await followUps.update(1, { status: "done", dueAt: null, notes: "Sent", promise: null }, "Sagnik");
    expect(closed).toMatchObject({ status: "done", notes: "Sent" });
    expect(closed?.closedAt).not.toBeNull();

    await tasks.create([draft("Incorporation docs")], { actor: "Sagnik", groupName: null, messageId: "t" });
    await checklists.add(1, ["PAN", "GST cert"], "Sagnik");
    await checklists.add(1, ["Board resolution"], "Tanvi");
    const ticked = await checklists.setDone(1, [2, 9], true, "Tanvi");
    expect(ticked.items.map((i) => [i.number, i.text, i.done])).toEqual([
      [1, "PAN", false],
      [2, "GST cert", true],
      [3, "Board resolution", false],
    ]);
    expect(ticked.missing).toEqual([9]);
  });
});

describe("TaskStore.undoLast", () => {
  it("reverses the sender's latest change and steps back on repeat", async () => {
    const { tasks } = services();
    await tasks.create([draft("Pay AWS")], { actor: "Sagnik", groupName: null, messageId: "m1" });
    await tasks.update(1, { title: null, status: "done", priority: "high", owner: null, area: null, dueAt: null, tags: null, notesMode: null, notes: null, clear: [] }, "Sagnik");
    await tasks.create([draft("Tanvi's task")], { actor: "Tanvi", groupName: null, messageId: "m2" });

    const first = await tasks.undoLast("Sagnik");
    expect(first).toMatchObject({ action: "reverted", task: { id: 1, status: "todo", priority: null } });
    const second = await tasks.undoLast("Sagnik");
    expect(second).toMatchObject({ action: "removed", task: { id: 1 } });
    expect(await tasks.get(1)).toBeNull();
    expect(await tasks.undoLast("Sagnik")).toBeNull();
    expect(await tasks.get(2)).not.toBeNull();

    await tasks.delete(2, "Tanvi");
    expect(await tasks.undoLast("Tanvi")).toMatchObject({ action: "restored", task: { id: 2 } });
    expect(await tasks.get(2)).not.toBeNull();
  });
});

describe("Phase 1 assistant tools", () => {
  function scripted(...turns: CompletionResult[]) {
    const requests: CompletionRequest[] = [];
    const complete = vi.fn(async (request: CompletionRequest) => {
      requests.push({ ...request, messages: [...request.messages] });
      const next = turns.shift();
      if (!next) throw new Error("out of turns");
      return next;
    });
    return { complete, requests };
  }

  function assistant(llm: ReturnType<typeof scripted>) {
    const s = services();
    const phase1 = new Phase1Tools(s, s.tasks, "Asia/Kolkata", logger);
    return {
      ...s,
      bot: new DiaAssistant({
        llm,
        botName: "Patch",
        timezone: "Asia/Kolkata",
        tasks: s.tasks,
        modules: [phase1],
        checklists: s.checklists,
        logger,
      }),
    };
  }

  const request = (body: string, extra: object = {}) => ({
    groupId: "g1",
    groupName: "HQ",
    messageId: "msg",
    requestedBy: "Sagnik",
    requestedById: "s@c.us",
    body,
    quotedMessage: null,
    recentContext: [],
    ...extra,
  });

  it("detects Phase 1 intents and referenced ids", () => {
    expect(isPhase1Request("remember that Rahul prefers email")).toBe(true);
    expect(isPhase1Request("I told Rahul I'd send the deck Friday")).toBe(true);
    expect(isPhase1Request("every Monday: send the pipeline update")).toBe(true);
    expect(isPhase1Request("remind me every 30 minutes to stretch")).toBe(false);
    expect(isPhase1Request("undo that")).toBe(true);
    expect(referencedPhase1Ids("close F3 and follow-up 4, pause R2, forget M7")).toEqual({
      memories: new Set([7]),
      followUps: new Set([3, 4]),
      recurring: new Set([2]),
    });
  });

  it("logs a decision and refuses to forget a memory it has not seen", async () => {
    const llm = scripted(
      toolTurn("r1", "remember", { kind: "Decision", subject: "pricing", content: "We price per repo." }),
      toolTurn("f1", "forget_memory", { memory_id: 99 }),
      textTurn("I couldn't find that one."),
    );
    const { bot } = assistant(llm);
    expect(await bot.respond(request("@patch log decision: we price per repo"))).toBe(
      "🧠 Decision logged (M1, decision): We price per repo.",
    );
    expect(llm.requests[0]?.toolChoice).toBe("required");
    expect(await bot.respond(request("@patch forget the old pricing memory"))).toBe("I couldn't find that one.");
    expect(JSON.stringify(llm.requests[2]?.messages)).toContain("Nothing was changed");
  });

  it("tracks a follow-up and closes it by its F id", async () => {
    const llm = scripted(
      toolTurn("c", "create_follow_ups", { follow_ups: [{ owner: "me", counterparty: "Rahul", promise: "Send the DPA", due_at: "2026-11-06" }] }),
      toolTurn("u", "update_follow_ups", { updates: [{ follow_up_id: 1, status: "done" }] }),
    );
    const { bot } = assistant(llm);
    expect(await bot.respond(request("@patch I told Rahul I'd send the DPA by Friday"))).toBe(
      "🤝 Tracking 1 follow-up:\n• F1 Sagnik → Rahul: Send the DPA — due 6 Nov 2026",
    );
    expect(await bot.respond(request("@patch F1 is done"))).toBe("🎉 F1 Sagnik → Rahul: Send the DPA — due 6 Nov 2026 — done");
  });

  it("undoes the sender's last task change", async () => {
    const llm = scripted(toolTurn("u", "undo_last_change", {}));
    const { bot, tasks } = assistant(llm);
    await tasks.create([draft("Oops task")], { actor: "Sagnik", groupName: null, messageId: "m0" });
    expect(await bot.respond(request("@patch undo that"))).toBe("↩️ Undone: removed #1 Oops task.");
  });
});

describe("Phase 1 scheduler jobs", () => {
  it("computes the next Monday 09:30 IST", () => {
    expect(new Date(nextWeeklyRunAt(Date.parse(NOW), 1, "09:30", "Asia/Kolkata")).toISOString()).toBe(
      "2026-11-09T04:00:00.000Z",
    );
  });

  it("sends the Monday review from last week and distills memory silently", async () => {
    const state = new Map<string, number>([["weekly_review:g1", 0], ["memory_distill:g1", 0]]);
    const reminders = {
      due: vi.fn().mockReturnValue([]),
      getOrCreateNextRun: vi.fn((key: string, initial: number) => {
        if (!state.has(key)) state.set(key, initial);
        return state.get(key) as number;
      }),
      setNextRun: vi.fn((key: string, value: number) => void state.set(key, value)),
      listActive: vi.fn().mockReturnValue([]),
    };
    const conversation = new ConversationStore(":memory:");
    const now = Date.parse("2026-11-09T04:01:00.000Z");
    conversation.record({ groupId: "g1", messageId: "m", author: "Tanvi", body: "Shipped onboarding v2", fromBot: false, sentAtMs: now - 86_400_000 });
    const generate = vi.fn().mockResolvedValue("📅 Monday review");
    const run = vi.fn().mockResolvedValue(2);
    const send = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ProactiveScheduler({
      reminders: reminders as never,
      tasks: { listOpen: vi.fn() },
      conversation,
      timezone: "Asia/Kolkata",
      logger,
      weeklyReview: {
        weekday: 1,
        time: "09:30",
        groupIds: new Set(["g1"]),
        tasks: { listOpen: vi.fn().mockResolvedValue({ tasks: [], hasMore: false }), listClosedSince: vi.fn().mockResolvedValue([]) },
        followUps: { list: vi.fn().mockResolvedValue([]) },
        memory: { search: vi.fn().mockResolvedValue([]) },
        generate,
      },
      memoryJob: { time: "23:30", groups: (since) => conversation.activeGroups(since), run },
    });

    await scheduler.runOnce(now, send);

    expect(send).toHaveBeenCalledWith("g1", "📅 Monday review");
    expect(generate.mock.calls[0]?.[0].conversation.map((m: { body: string }) => m.body)).toEqual(["Shipped onboarding v2"]);
    expect(state.get("weekly_review:g1")).toBe(Date.parse("2026-11-16T04:00:00.000Z"));
    expect(run).toHaveBeenCalledWith("g1", expect.any(Number), now);
    expect(send).toHaveBeenCalledOnce(); // memory never posts
    conversation.close();
  });
});
