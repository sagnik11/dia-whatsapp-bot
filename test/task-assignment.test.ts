import { afterEach, describe, expect, it, vi } from "vitest";
import { DiaAssistant } from "../src/assistant.js";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "../src/d1-schema.js";
import type { CompletionRequest, LanguageModel } from "../src/llm.js";
import { MemoryStore } from "../src/memory-store.js";
import { PEOPLE_SCHEMA_STATEMENTS, PeopleStore } from "../src/people-store.js";
import { TaskAssigner, defaultDueDate } from "../src/task-assignment.js";
import { TaskStore } from "../src/task-store.js";
import type { AssistantRequest } from "../src/types.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function team() {
  const db = createSqliteExecutor();
  cleanups.push(() => db.close());
  const schema = new SchemaGate(db, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
  const people = new PeopleStore({ db, schema: new SchemaGate(db, PEOPLE_SCHEMA_STATEMENTS, logger, "People"), logger });
  const tanvi = await people.ensure({ name: "Tanvi", senderIds: ["t@c.us"] });
  await people.setProfile(tanvi.id, { role: "Cofounder: finance, compliance and the CA" }, "Tanvi");
  await people.ensure({ name: "Sagnik", senderIds: ["s@c.us"] });
  const memory = new MemoryStore({ db, schema, logger });
  await memory.add(
    "g1",
    [{ kind: "person", subject: "Rahul", content: "Rahul at Acme deals only with Sagnik.", sourceAuthor: "Sagnik", sourceMessageId: null, observedAt: "2026-11-01T10:00:00.000Z" }],
    "Sagnik",
  );
  const tasks = new TaskStore({ db, timezone: "Asia/Kolkata", logger });
  return { db, people, memory, tasks };
}

function request(body: string): AssistantRequest {
  return { groupId: "g1", groupName: "HQ", messageId: "m1", requestedBy: "Sagnik", requestedById: "s@c.us", body, quotedMessage: null, recentContext: [] };
}

describe("default due date", () => {
  it("is the local date a week out", () => {
    // 20:00 UTC on 4 Nov is already 5 Nov in India.
    expect(defaultDueDate(Date.parse("2026-11-04T20:00:00.000Z"), "Asia/Kolkata")).toBe("2026-11-12");
    expect(defaultDueDate(Date.parse("2026-11-04T20:00:00.000Z"), "UTC")).toBe("2026-11-11");
  });
});

describe("TaskAssigner", () => {
  it("asks the model with roles, memory and past owners, and keeps only known people", async () => {
    const { people, memory, tasks } = await team();
    const calls: CompletionRequest[] = [];
    const llm: LanguageModel = {
      complete: async (call) => {
        calls.push(call);
        return textTurn(
          JSON.stringify({
            assignments: [
              { task: 0, owner: "tanvi", reason: "handles finance and the CA" },
              { task: 1, owner: "Rahul", reason: "he asked" },
            ],
          }),
        );
      },
    };
    const assigner = new TaskAssigner({ llm, tasks, people, memory, logger });
    const picks = await assigner.assign({
      groupId: "g1",
      requester: "Sagnik",
      tasks: [
        { index: 0, title: "File the GST return", notes: null, area: "Finance" },
        { index: 1, title: "Send Rahul the pilot SOW", notes: null, area: "Sales" },
      ],
    });
    expect(picks.get(0)).toEqual({ owner: "Tanvi", reason: "handles finance and the CA", fallback: false });
    // Rahul is not on the team, so the requester gets it.
    expect(picks.get(1)).toEqual({ owner: "Sagnik", reason: "no owner named, so you", fallback: true });
    const sent = JSON.parse(String(calls[0]?.messages[0]?.content)) as { candidates: Array<{ name: string; role?: string }>; memory: Array<{ content: string }> };
    expect(sent.candidates).toContainEqual({ name: "Tanvi", role: "Cofounder: finance, compliance and the CA", focus: null, about: null });
    expect(sent.memory.map((item) => item.content)).toContain("Rahul at Acme deals only with Sagnik.");
  });

  it("gives everything to the requester when the model fails or nobody else is known", async () => {
    const db = createSqliteExecutor();
    cleanups.push(() => db.close());
    const tasks = new TaskStore({ db, timezone: "Asia/Kolkata", logger });
    const failing: LanguageModel = { complete: vi.fn(async () => { throw new Error("gateway down"); }) };
    const alone = new TaskAssigner({ llm: failing, tasks, logger });
    const picks = await alone.assign({ groupId: "g1", requester: "Sagnik", tasks: [{ index: 0, title: "Renew domain", notes: null, area: null }] });
    expect(picks.get(0)?.owner).toBe("Sagnik");
    expect(failing.complete).not.toHaveBeenCalled(); // only one known person: no model call

    const { people, tasks: teamTasks } = await team();
    const withTeam = new TaskAssigner({ llm: failing, tasks: teamTasks, people, logger });
    expect((await withTeam.assign({ groupId: "g1", requester: "Sagnik", tasks: [{ index: 0, title: "x", notes: null, area: null }] })).get(0)).toMatchObject({ owner: "Sagnik", fallback: true });
  });
});

describe("every task gets an owner and a due date", () => {
  it("fills both in when creating, says so, and refuses to clear them later", async () => {
    const { people, memory, tasks } = await team();
    const model = (turns: ReturnType<typeof toolTurn>[]): LanguageModel => ({
      complete: async (call) => {
        if (call.metadata?.feature === "task_owner") {
          return textTurn(JSON.stringify({ assignments: [{ task: 0, owner: "Tanvi", reason: "handles finance and the CA" }] }));
        }
        const next = turns.shift();
        if (!next) throw new Error("out of turns");
        return next;
      },
    });
    const llm = model([toolTurn("c1", "create_tasks", { tasks: [{ title: "File the GST return" }] })]);
    const assistant = new DiaAssistant({
      llm,
      botName: "Patch",
      timezone: "Asia/Kolkata",
      tasks,
      assignOwners: new TaskAssigner({ llm, tasks, people, memory, logger }),
      logger,
    });
    const reply = await assistant.respond(request("@patch add a task to file the GST return"));
    expect(reply).toMatch(/^✅ Task #1 added: File the GST return — owner Tanvi · due \d{1,2} \w+ \d{4}\n/);
    expect(reply).toContain("👤 Owner picked: #1 → Tanvi (handles finance and the CA)");
    expect(reply).toContain("📅 No date given, so #1 is due in 7 days.");
    const stored = await tasks.get(1);
    expect(stored?.owner).toBe("Tanvi");
    expect(stored?.dueAt).not.toBeNull();

    const clearing = model([
      toolTurn("c2", "update_tasks", { updates: [{ task_id: 1, clear_fields: ["owner", "due_at"] }] }),
      textTurn("Every task keeps an owner and a due date; tell me who should take it or the new date."),
    ]);
    const second = new DiaAssistant({ llm: clearing, botName: "Patch", timezone: "Asia/Kolkata", tasks, logger });
    await second.respond(request("@patch remove the owner and due date from #1"));
    expect((await tasks.get(1))?.owner).toBe("Tanvi");
    expect((await tasks.get(1))?.dueAt).toBe(stored?.dueAt);
  });
});
