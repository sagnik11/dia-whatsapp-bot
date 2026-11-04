import { describe, expect, it, vi } from "vitest";
import {
  ProactiveScheduler,
  formatReminderDelivery,
  nextDailyRunAt,
} from "../src/scheduler.js";
import { ConversationStore } from "../src/conversation-store.js";
import type { ReminderRecord } from "../src/types.js";

const reminder: ReminderRecord = {
  id: 7,
  groupId: "group@g.us",
  requestedBy: "Sagnik",
  requestedById: "sagnik@c.us",
  message: "Ship the release",
  dueAt: "2026-08-11T10:30:00.000Z",
  notifyBeforeMinutes: 10,
  repeatEveryMinutes: null,
  nextFireAt: "2026-08-11T10:20:00.000Z",
  phase: "pre_due",
};

describe("scheduler formatting", () => {
  it("formats advance reminders", () => {
    expect(formatReminderDelivery(reminder)).toContain("Due in 10 minutes");
  });

  it("calculates a daily run in the configured timezone", () => {
    expect(
      new Date(
        nextDailyRunAt(
          Date.parse("2026-08-11T02:00:00.000Z"),
          "09:00",
          "Asia/Kolkata",
        ),
      ).toISOString(),
    ).toBe("2026-08-11T03:30:00.000Z");
  });
});

describe("ProactiveScheduler", () => {
  it("delivers due reminders and never sends an unsolicited task digest", async () => {
    const advanceAfterDelivery = vi.fn();
    const reminders = {
      due: vi.fn().mockReturnValue([reminder]),
      advanceAfterDelivery,
      getOrCreateNextRun: vi.fn().mockReturnValue(0),
      setNextRun: vi.fn(),
    };
    const tasks = { listOpen: vi.fn() };
    const send = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ProactiveScheduler({
      reminders: reminders as never,
      tasks,
      timezone: "Asia/Kolkata",
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });

    const now = Date.parse("2026-08-11T10:20:00.000Z");
    await scheduler.runOnce(now, send);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      "group@g.us",
      expect.stringContaining("Due in 10 minutes"),
    );
    expect(advanceAfterDelivery).toHaveBeenCalledWith(reminder, now);
    expect(tasks.listOpen).not.toHaveBeenCalled();
  });

  it("writes the daily brief from the conversation since the last brief", async () => {
    const harness = briefHarness();
    harness.conversation.record({
      groupId: "group@g.us",
      messageId: "m1",
      author: "Tanvi",
      body: "Decided: we price per repo. I'll update the deck by Friday.",
      fromBot: false,
      sentAtMs: Date.parse("2026-08-11T02:00:00.000Z"),
    });

    const now = Date.parse("2026-08-11T03:31:00.000Z");
    await harness.scheduler.runOnce(now, harness.send);

    expect(harness.generate).toHaveBeenCalledOnce();
    const input = harness.generate.mock.calls[0]?.[0];
    expect(input.conversation.map((m: { body: string }) => m.body)).toEqual([
      "Decided: we price per repo. I'll update the deck by Friday.",
    ]);
    expect(input).toMatchObject({ reminders: [reminder], sinceMs: now - 24 * 60 * 60 * 1_000, untilMs: now });
    expect(harness.send).toHaveBeenCalledWith("group@g.us", "🧭 Founder brief");
    expect(harness.state.get("founder_brief_since:group@g.us")).toBe(now);
    expect(harness.state.get("founder_brief:group@g.us")).toBeGreaterThan(now);
  });

  it("skips the brief when only Patch spoke, and covers the gap the next day", async () => {
    const harness = briefHarness();
    harness.conversation.record({
      groupId: "group@g.us",
      messageId: "bot-1",
      author: "Captain Patch",
      body: "⏰ Due now",
      fromBot: true,
      sentAtMs: Date.parse("2026-08-11T02:00:00.000Z"),
    });

    const day1 = Date.parse("2026-08-11T03:31:00.000Z");
    await harness.scheduler.runOnce(day1, harness.send);
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    const windowStart = harness.state.get("founder_brief_since:group@g.us");

    harness.conversation.record({
      groupId: "group@g.us",
      messageId: "m2",
      author: "Sagnik",
      body: "Rahul signed the pilot",
      fromBot: false,
      sentAtMs: Date.parse("2026-08-11T12:00:00.000Z"),
    });
    const day2 = Date.parse("2026-08-12T03:31:00.000Z");
    await harness.scheduler.runOnce(day2, harness.send);
    expect(harness.generate.mock.calls[0]?.[0].sinceMs).toBe(windowStart);
    expect(harness.send).toHaveBeenCalledOnce();
  });
});

function briefHarness() {
  // Make today's brief due; the window start is left for the scheduler to set.
  const state = new Map<string, number>([["founder_brief:group@g.us", 0]]);
  const reminders = {
    due: vi.fn().mockReturnValue([]),
    getOrCreateNextRun: vi.fn((key: string, initial: number) => {
      if (!state.has(key)) state.set(key, initial);
      return state.get(key) as number;
    }),
    setNextRun: vi.fn((key: string, value: number) => void state.set(key, value)),
    listActive: vi.fn().mockReturnValue([reminder]),
  };
  const conversation = new ConversationStore(":memory:");
  const generate = vi.fn().mockResolvedValue("🧭 Founder brief");
  const send = vi.fn().mockResolvedValue(undefined);
  const scheduler = new ProactiveScheduler({
    reminders: reminders as never,
    tasks: { listOpen: vi.fn().mockResolvedValue({ tasks: [], hasMore: false }) },
    conversation,
    conversationRetentionDays: 14,
    timezone: "Asia/Kolkata",
    founderBrief: { time: "09:00", groupIds: new Set(["group@g.us"]), generate },
    logger: { info: vi.fn(), error: vi.fn() } as never,
  });
  return { state, conversation, generate, send, scheduler };
}
