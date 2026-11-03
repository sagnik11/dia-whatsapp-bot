import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TASK_SCHEMA_STATEMENTS,
  TaskNotFoundError,
  TaskStore,
  type TaskCreateInput,
} from "../src/task-store.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn() } as never;

function draft(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return {
    title: "Send investor update",
    notes: null,
    status: null,
    priority: null,
    owner: null,
    area: null,
    dueAt: null,
    tags: [],
    ...overrides,
  };
}

const source = { actor: "Sagnik", groupName: "Autter HQ", messageId: "msg-1" };

let executor: ReturnType<typeof createSqliteExecutor> | undefined;

function createStore(now = "2026-11-04T06:30:00.000Z"): TaskStore {
  executor = createSqliteExecutor();
  return new TaskStore({
    db: executor,
    timezone: "Asia/Kolkata",
    logger,
    now: () => new Date(now),
  });
}

afterEach(() => {
  executor?.close();
  executor = undefined;
});

describe("TaskStore schema", () => {
  it("matches the checked-in D1 migration", () => {
    const migration = readFileSync(
      new URL("../migrations/0001_tasks.sql", import.meta.url),
      "utf8",
    );
    const statements = migration
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual(
      TASK_SCHEMA_STATEMENTS.map((statement) => statement.replace(/\s+/g, " ").trim()),
    );
  });
});

describe("TaskStore", () => {
  it("creates tasks with defaults and skips a retried duplicate", async () => {
    const store = createStore();
    const [first] = await store.create(
      [draft({ owner: "Tanvi", dueAt: "2026-11-06", tags: ["#Fundraise", "fundraise"] })],
      source,
    );
    expect(first?.duplicate).toBe(false);
    expect(first?.task).toMatchObject({
      id: 1,
      title: "Send investor update",
      status: "todo",
      owner: "Tanvi",
      dueAt: "2026-11-06",
      tags: ["Fundraise"],
      createdBy: "Sagnik",
    });

    const [retry] = await store.create([draft()], source);
    expect(retry).toMatchObject({ duplicate: true, task: { id: 1 } });

    const events = executor?.raw
      .prepare("SELECT action, actor FROM task_events")
      .all();
    expect(events).toEqual([{ action: "created", actor: "Sagnik" }]);
  });

  it("lists open tasks by due date and filters by owner, tag, text, and overdue", async () => {
    const store = createStore("2026-11-04T06:30:00.000Z");
    await store.create(
      [
        draft({ title: "File GST return", dueAt: "2026-11-03", owner: "Sagnik", area: "Finance" }),
        draft({ title: "Ship onboarding v2", dueAt: "2026-11-10", owner: "Tanvi", tags: ["launch"] }),
        draft({ title: "Draft blog post", owner: "tanvi", notes: "about merge gates" }),
        draft({ title: "Old closed item", status: "done" }),
      ],
      source,
    );

    const open = await store.listOpen();
    expect(open.tasks.map((task) => task.title)).toEqual([
      "File GST return",
      "Ship onboarding v2",
      "Draft blog post",
    ]);

    const tanvi = await store.list({ ...baseQuery(), owner: "TANVI" });
    expect(tanvi.tasks).toHaveLength(2);

    const tagged = await store.list({ ...baseQuery(), tag: "#Launch" });
    expect(tagged.tasks.map((task) => task.title)).toEqual(["Ship onboarding v2"]);

    const searched = await store.list({ ...baseQuery(), text: "merge" });
    expect(searched.tasks.map((task) => task.title)).toEqual(["Draft blog post"]);

    const overdue = await store.list({ ...baseQuery(), overdueOnly: true });
    expect(overdue.tasks.map((task) => task.title)).toEqual(["File GST return"]);

    const thisWeek = await store.list({
      ...baseQuery(),
      dueFrom: "2026-11-04",
      dueTo: "2026-11-10",
    });
    expect(thisWeek.tasks.map((task) => task.title)).toEqual(["Ship onboarding v2"]);

    const everything = await store.list({ ...baseQuery(), includeClosed: true, limit: 2 });
    expect(everything).toMatchObject({ hasMore: true });
  });

  it("updates fields, appends notes, tracks completion, and audits the diff", async () => {
    const store = createStore();
    await store.create([draft({ notes: "Use the Q3 numbers", priority: "low" })], source);

    const result = await store.update(
      1,
      {
        title: null,
        status: "done",
        priority: "high",
        owner: "Tanvi",
        area: null,
        dueAt: "2026-11-07T18:00:00+05:30",
        tags: ["investors"],
        notesMode: "append",
        notes: "Sent to the angel list.",
        clear: [],
      },
      "Tanvi",
    );

    expect(result.changedFields).toEqual([
      "status",
      "priority",
      "owner",
      "due_at",
      "tags",
      "notes",
    ]);
    expect(result.after).toMatchObject({
      status: "done",
      priority: "high",
      owner: "Tanvi",
      notes: "Use the Q3 numbers\n\nSent to the angel list.",
      completedAt: "2026-11-04T06:30:00.000Z",
    });

    const reopened = await store.update(
      1,
      {
        title: "Send November investor update",
        status: "in_progress",
        priority: null,
        owner: null,
        area: null,
        dueAt: null,
        tags: null,
        notesMode: null,
        notes: null,
        clear: ["owner", "due_at"],
      },
      "Sagnik",
    );
    expect(reopened.after).toMatchObject({
      title: "Send November investor update",
      status: "in_progress",
      owner: null,
      dueAt: null,
      completedAt: null,
    });

    const unchanged = await store.update(
      1,
      {
        title: "Send November investor update",
        status: "in_progress",
        priority: null,
        owner: null,
        area: null,
        dueAt: null,
        tags: null,
        notesMode: null,
        notes: null,
        clear: [],
      },
      "Sagnik",
    );
    expect(unchanged.changedFields).toEqual([]);

    const events = executor?.raw
      .prepare("SELECT action FROM task_events ORDER BY id")
      .all()
      .map((row) => (row as { action: string }).action);
    expect(events).toEqual(["created", "updated", "updated"]);
  });

  it("soft-deletes a task so it disappears from lists and further edits", async () => {
    const store = createStore();
    await store.create([draft()], source);

    const deleted = await store.delete(1, "Sagnik");
    expect(deleted.title).toBe("Send investor update");
    expect((await store.listOpen()).tasks).toEqual([]);
    expect(await store.get(1)).toBeNull();
    await expect(store.delete(1, "Sagnik")).rejects.toBeInstanceOf(TaskNotFoundError);

    const row = executor?.raw.prepare("SELECT deleted_at FROM tasks WHERE id = 1").get();
    expect(row).toEqual({ deleted_at: "2026-11-04T06:30:00.000Z" });
  });

  it("rejects due dates it cannot interpret instead of storing garbage", async () => {
    const store = createStore();
    await expect(store.create([draft({ dueAt: "next-ish" })], source)).rejects.toThrow(
      "not a valid due date",
    );
  });
});

function baseQuery() {
  return {
    text: null,
    statuses: null,
    includeClosed: false,
    owner: null,
    area: null,
    tag: null,
    dueFrom: null,
    dueTo: null,
    overdueOnly: false,
    limit: 20,
  };
}
