import { describe, expect, it, vi } from "vitest";
import {
  ProactiveScheduler,
  formatReminderDelivery,
  formatTaskDigestMessages,
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

  it("formats a bounded incomplete-task digest", () => {
    expect(
      formatTaskDigestMessages(
        {
          tasks: [
            {
              id: "task-1",
              url: "https://notion.so/task-1",
              title: "Send proposal",
              status: "In progress",
              dueAt: "2026-08-12T10:00:00.000Z",
              assignees: ["Tanvi"],
              priority: "High",
              taskTypes: ["Marketing"],
            },
          ],
          hasMore: false,
        },
        "Asia/Kolkata",
      )[0],
    ).toContain("Send proposal — In progress");
  });
});

describe("ProactiveScheduler", () => {
  it("delivers due reminders and an immediately due task digest", async () => {
    const advanceAfterDelivery = vi.fn();
    const setNextRun = vi.fn();
    const reminders = {
      due: vi.fn().mockReturnValue([reminder]),
      advanceAfterDelivery,
      getOrCreateNextRun: vi.fn().mockReturnValue(0),
      setNextRun,
    };
    const notion = {
      listIncompleteTasks: vi.fn().mockResolvedValue({ tasks: [], hasMore: false }),
    };
    const send = vi.fn().mockResolvedValue(undefined);
    const scheduler = new ProactiveScheduler({
      reminders: reminders as never,
      notion: notion as never,
      digestGroupIds: new Set(["group@g.us"]),
      digestIntervalHours: 4,
      timezone: "Asia/Kolkata",
      logger: { info: vi.fn(), error: vi.fn() } as never,
    });

    const now = Date.parse("2026-08-11T10:20:00.000Z");
    await scheduler.runOnce(now, send);

    expect(send).toHaveBeenCalledWith(
      "group@g.us",
      expect.stringContaining("Due in 10 minutes"),
    );
    expect(send).toHaveBeenCalledWith(
      "group@g.us",
      expect.stringContaining("no incomplete tasks"),
    );
    expect(advanceAfterDelivery).toHaveBeenCalledWith(reminder, now);
    expect(setNextRun).toHaveBeenCalledWith(
      "task_digest:group@g.us",
      now + 4 * 60 * 60 * 1_000,
    );
  });
});
