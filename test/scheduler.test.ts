import { describe, expect, it, vi } from "vitest";
import {
  ProactiveScheduler,
  formatReminderDelivery,
  nextDailyRunAt,
} from "../src/scheduler.js";
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

  it("generates a persisted daily founder brief for due groups", async () => {
    const setNextRun = vi.fn();
    const reminders = {
      due: vi.fn().mockReturnValue([]),
      getOrCreateNextRun: vi.fn().mockImplementation((key: string) =>
        key.startsWith("founder_brief:") ? 0 : Number.MAX_SAFE_INTEGER,
      ),
      setNextRun,
      listActive: vi.fn().mockReturnValue([reminder]),
    };
    const tasks = { tasks: [], hasMore: false };
    const taskStore = { listOpen: vi.fn().mockResolvedValue(tasks) };
    const generate = vi.fn().mockResolvedValue("🧭 Founder brief");
    const send = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ProactiveScheduler({
      reminders: reminders as never,
      tasks: taskStore,
      timezone: "Asia/Kolkata",
      founderBrief: {
        time: "09:00",
        groupIds: new Set(["group@g.us"]),
        generate,
      },
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });

    const now = Date.parse("2026-08-11T03:31:00.000Z");
    await scheduler.runOnce(now, send);

    expect(generate).toHaveBeenCalledWith(tasks, [reminder]);
    expect(send).toHaveBeenCalledWith("group@g.us", "🧭 Founder brief");
    expect(setNextRun).toHaveBeenCalledWith(
      "founder_brief:group@g.us",
      expect.any(Number),
    );
  });
});
