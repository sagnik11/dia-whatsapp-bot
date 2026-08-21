import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReminderStore } from "../src/reminder-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function createStore(): ReminderStore {
  const directory = mkdtempSync(join(tmpdir(), "patch-reminders-"));
  temporaryDirectories.push(directory);
  return new ReminderStore(join(directory, "dia.sqlite"));
}

describe("ReminderStore", () => {
  it("persists an advance notification and due notification", () => {
    const store = createStore();
    const now = Date.parse("2026-08-11T10:00:00.000Z");
    const reminder = store.create(
      {
        groupId: "group@g.us",
        requestedBy: "Sagnik",
        requestedById: "sagnik@c.us",
        sourceMessageId: "message-1",
        message: "Send the proposal",
        dueAt: "2026-08-11T10:30:00.000Z",
        notifyBeforeMinutes: 10,
        repeatEveryMinutes: null,
      },
      now,
    );

    expect(reminder.phase).toBe("pre_due");
    expect(reminder.nextFireAt).toBe("2026-08-11T10:20:00.000Z");
    expect(store.due(Date.parse("2026-08-11T10:19:59.000Z"))).toEqual([]);
    expect(store.due(Date.parse("2026-08-11T10:20:00.000Z"))).toHaveLength(1);

    store.advanceAfterDelivery(
      reminder,
      Date.parse("2026-08-11T10:20:00.000Z"),
    );
    const dueReminder = store.due(Date.parse("2026-08-11T10:30:00.000Z"))[0];
    expect(dueReminder?.phase).toBe("due");
    if (!dueReminder) throw new Error("Expected due reminder");
    store.advanceAfterDelivery(
      dueReminder,
      Date.parse("2026-08-11T10:30:00.000Z"),
    );
    expect(store.listActive("group@g.us")).toEqual([]);
    store.close();
  });

  it("repeats after the due time until cancelled", () => {
    const store = createStore();
    const now = Date.parse("2026-08-11T10:00:00.000Z");
    const reminder = store.create(
      {
        groupId: "group@g.us",
        requestedBy: "Tanvi",
        requestedById: "tanvi@c.us",
        sourceMessageId: "message-2",
        message: "Review the campaign",
        dueAt: "2026-08-11T10:05:00.000Z",
        notifyBeforeMinutes: 0,
        repeatEveryMinutes: 15,
      },
      now,
    );

    store.advanceAfterDelivery(
      reminder,
      Date.parse("2026-08-11T10:05:00.000Z"),
    );
    const repeated = store.listActive("group@g.us")[0];
    expect(repeated).toMatchObject({
      phase: "repeat",
      nextFireAt: "2026-08-11T10:20:00.000Z",
    });
    expect(repeated && store.cancel(repeated.id, "group@g.us")).toBe(true);
    expect(store.listActive("group@g.us")).toEqual([]);
    store.close();
  });

  it("stops a repeating reminder when it is marked completed", () => {
    const store = createStore();
    const now = Date.parse("2026-08-11T10:00:00.000Z");
    const reminder = store.create(
      {
        groupId: "group@g.us",
        requestedBy: "Sagnik",
        requestedById: "sagnik@c.us",
        sourceMessageId: "message-complete",
        message: "Finish the community website",
        dueAt: "2026-08-11T10:05:00.000Z",
        notifyBeforeMinutes: 0,
        repeatEveryMinutes: 240,
      },
      now,
    );

    expect(store.complete(reminder.id, "another-group@g.us")).toBe(false);
    expect(store.complete(reminder.id, "group@g.us")).toBe(true);
    expect(store.listActive("group@g.us")).toEqual([]);
    expect(store.due(Date.parse("2026-08-12T10:00:00.000Z"))).toEqual([]);
    store.close();
  });

  it("deduplicates reminder creation by source message ID", () => {
    const store = createStore();
    const input = {
      groupId: "group@g.us",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      sourceMessageId: "message-3",
      message: "Call the accountant",
      dueAt: "2026-08-11T11:00:00.000Z",
      notifyBeforeMinutes: 10,
      repeatEveryMinutes: null,
    };

    const first = store.create(input, Date.parse("2026-08-11T10:00:00.000Z"));
    const second = store.create(input, Date.parse("2026-08-11T10:00:01.000Z"));
    expect(second.id).toBe(first.id);
    expect(store.listActive("group@g.us")).toHaveLength(1);
    store.close();
  });
});
