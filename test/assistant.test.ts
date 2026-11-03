import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiaAssistant,
  formatSpendConfirmation,
  formatTaskCreateConfirmation,
  isConversationRequest,
  isDekhteHaiRequest,
  isExplicitBrainDumpAppendRequest,
  isExplicitBrainDumpRequest,
  isExplicitKnowledgeRequest,
  isExplicitReminderCancelRequest,
  isExplicitReminderCompleteRequest,
  isExplicitReminderCreateRequest,
  isExplicitReminderListRequest,
  isExplicitResearchRequest,
  isExplicitSpendCreateRequest,
  isExplicitSpendReadRequest,
  isExplicitTaskDeleteRequest,
  isExplicitTaskReadRequest,
  isExplicitTaskRequest,
  isExplicitTaskUpdateRequest,
  isExplicitWebSearchRequest,
  referencedTaskIds,
} from "../src/assistant.js";
import { ConversationStore } from "../src/conversation-store.js";
import type { CompletionRequest, CompletionResult, LanguageModel } from "../src/llm.js";
import { TaskStore } from "../src/task-store.js";
import type { AssistantRequest } from "../src/types.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

let executor: ReturnType<typeof createSqliteExecutor> | undefined;

afterEach(() => {
  executor?.close();
  executor = undefined;
});

function taskStore(): TaskStore {
  executor = createSqliteExecutor();
  return new TaskStore({ db: executor, timezone: "Asia/Kolkata", logger });
}

function scriptedModel(...turns: CompletionResult[]): LanguageModel & {
  complete: ReturnType<typeof vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>>;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  const complete = vi.fn(async (request: CompletionRequest) => {
    // Snapshot messages: the assistant keeps appending to the same array.
    requests.push({ ...request, messages: [...request.messages] });
    const next = turns.shift();
    if (!next) throw new Error("The scripted model ran out of turns");
    return next;
  });
  return { complete, requests };
}

function request(body: string, overrides: Partial<AssistantRequest> = {}): AssistantRequest {
  return {
    groupId: "group@g.us",
    groupName: "Autter HQ",
    messageId: "msg-1",
    requestedBy: "Sagnik",
    requestedById: "sagnik@c.us",
    body,
    quotedMessage: null,
    recentContext: [],
    ...overrides,
  };
}

function assistantWith(llm: LanguageModel, tasks: TaskStore, extra: object = {}) {
  return new DiaAssistant({
    llm,
    botName: "Captain Patch",
    timezone: "Asia/Kolkata",
    tasks,
    logger,
    ...extra,
  });
}

describe("task intent detection", () => {
  it.each([
    "add a task to send the proposal",
    "create a high priority task for tomorrow",
    "turn the quoted message into tasks",
    "capture these as tasks: call Rahul, renew the domain",
  ])("detects task capture: %s", (message) => {
    expect(isExplicitTaskRequest(message)).toBe(true);
  });

  it("does not mistake a planning question for task capture", () => {
    expect(isExplicitTaskRequest("what tasks should I add next?")).toBe(false);
    expect(isExplicitTaskReadRequest("what tasks should I add next?")).toBe(false);
  });

  it.each([
    "show me my tasks",
    "what tasks are pending?",
    "which tasks are due this week?",
    "what's overdue?",
  ])("detects a task-list question: %s", (message) => {
    expect(isExplicitTaskReadRequest(message)).toBe(true);
  });

  it.each([
    "mark task 12 as done",
    "shift the intern feedback task to in progress and assign it to Tanvi",
    "change the due date of the GST task to Friday",
  ])("detects a task edit: %s", (message) => {
    expect(isExplicitTaskUpdateRequest(message)).toBe(true);
  });

  it.each(["delete task 5", "remove the GST filing task", "delete tasks 4 and 5"])(
    "detects a task delete: %s",
    (message) => {
      expect(isExplicitTaskDeleteRequest(message)).toBe(true);
    },
  );

  it("treats clearing a field as an edit, not a delete", () => {
    expect(isExplicitTaskDeleteRequest("remove the due date from task 4")).toBe(false);
  });

  it("collects task ids the founder named directly", () => {
    expect([...referencedTaskIds("mark #3 done and tasks 7, 8 and 9 as blocked")]).toEqual([
      3, 7, 8, 9,
    ]);
    expect([...referencedTaskIds("a task for 5 people")]).toEqual([]);
  });
});

describe("spend and reminder intent detection", () => {
  it("detects bulk spend writes without confusing them with reads", () => {
    const message = "add to daily spend log: Expenses by Tanvi: 12th aug chai 100rs upi";
    expect(isExplicitSpendCreateRequest(message)).toBe(true);
    expect(isExplicitSpendReadRequest(message)).toBe(false);
    expect(isExplicitSpendReadRequest("how much did Tanvi spend this month?")).toBe(true);
  });

  it("detects reminder creation, listing, completion, and cancellation", () => {
    expect(isExplicitReminderCreateRequest("remind me to send the proposal at 4")).toBe(true);
    expect(isExplicitReminderListRequest("show my reminders")).toBe(true);
    expect(isExplicitReminderCompleteRequest("mark reminder number 7 as completed")).toBe(true);
    expect(isExplicitReminderCompleteRequest("which reminders are completed?")).toBe(false);
    expect(isExplicitReminderCancelRequest("cancel reminder 4")).toBe(true);
  });
});

describe("confirmation formatting", () => {
  it("confirms a created task with its id and key details", () => {
    expect(
      formatTaskCreateConfirmation(
        [
          {
            duplicate: false,
            task: {
              id: 4,
              title: "Send proposal",
              notes: null,
              status: "todo",
              priority: "high",
              owner: "Tanvi",
              area: null,
              dueAt: "2026-11-06",
              tags: [],
              createdBy: "Sagnik",
              createdAt: "",
              updatedAt: "",
              completedAt: null,
            },
          },
        ],
        "Asia/Kolkata",
      ),
    ).toBe("✅ Task #4 added: Send proposal — owner Tanvi · due 6 Nov 2026 · high priority");
  });

  it("confirms the spend batch count, INR total, and payer", () => {
    expect(
      formatSpendConfirmation({
        paidBy: "Tanvi",
        results: [],
        createdCount: 2,
        duplicateCount: 0,
        failedCount: 0,
        createdAmount: 1500,
      }),
    ).toBe("✅ Spend log updated: 2 entries · ₹1,500 · paid by Tanvi.");
  });
});

describe("isExplicitWebSearchRequest", () => {
  it.each([
    "search the web for the best code review tools",
    "what is the latest GitHub news?",
    "look up https://autter.dev",
  ])("detects a request needing live web access: %s", (message) => {
    expect(isExplicitWebSearchRequest(message)).toBe(true);
  });

  it("does not force web search for stable conversation", () => {
    expect(isExplicitWebSearchRequest("write a funny launch message")).toBe(false);
  });
});

describe("isExplicitResearchRequest", () => {
  it.each([
    "research the best places to publish our launch",
    "do a competitive analysis of AI code review tools",
    "deep dive into developer trust signals",
  ])("detects delegated research: %s", (message) => {
    expect(isExplicitResearchRequest(message)).toBe(true);
  });

  it("does not turn a quick current-fact lookup into deep research", () => {
    expect(isExplicitResearchRequest("what is today's GitHub news?")).toBe(false);
  });
});

describe("isExplicitBrainDumpRequest", () => {
  it.each([
    "summarize the Brain Dump",
    "what onboarding feedback is in our brain-dump?",
  ])("detects a Brain Dump request: %s", (message) => {
    expect(isExplicitBrainDumpRequest(message)).toBe(true);
  });

  it("does not confuse ordinary idea questions with configured Notion content", () => {
    expect(isExplicitBrainDumpRequest("brainstorm some launch ideas")).toBe(false);
  });
});

describe("isExplicitBrainDumpAppendRequest", () => {
  it.each([
    "add this onboarding feedback to the Brain Dump",
    "please append this to our brain-dump: improve secret detection",
    "Brain Dump — capture the idea from the quoted message",
    "What you can do now is research this further and put my notes and your findings separately in the Brain Dump",
  ])("detects an explicit Brain Dump append: %s", (message) => {
    expect(isExplicitBrainDumpAppendRequest(message)).toBe(true);
  });

  it.each([
    "summarize the Brain Dump",
    "what did I put in the Brain Dump?",
    "what should I add to the Brain Dump?",
  ])("does not mutate for a Brain Dump question: %s", (message) => {
    expect(isExplicitBrainDumpAppendRequest(message)).toBe(false);
  });
});

describe("isExplicitKnowledgeRequest", () => {
  it.each([
    "search Autter HQ for our company goals",
    "look in Notion for the sales process",
    "summarize our company wiki",
  ])("detects an explicit company knowledge request: %s", (message) => {
    expect(isExplicitKnowledgeRequest(message)).toBe(true);
  });

  it("does not search internal knowledge for a general question", () => {
    expect(isExplicitKnowledgeRequest("explain semantic versioning")).toBe(false);
  });
});

describe("Dekhte Hai live-script routing", () => {
  it.each([
    "summarize all Dekhte Hai scripts",
    "write the next dekhte hain episode using our previous voice",
  ])("recognizes a series request: %s", (message) => {
    expect(isDekhteHaiRequest(message)).toBe(true);
  });
});

describe("DiaAssistant task list", () => {
  it("captures several tasks, forces a tool turn, and keeps ambient chatter out", async () => {
    const tasks = taskStore();
    const llm = scriptedModel(
      toolTurn("c1", "create_tasks", {
        tasks: [
          { title: "Renew autter.dev domain", owner: "me", due_at: "2026-11-10", priority: "High" },
          { title: "Call Rahul about the pilot", owner: "Tanvi", area: "sales" },
        ],
      }),
    );

    const reply = await assistantWith(llm, tasks).respond(
      request("@patch add tasks: renew the domain by the 10th, Tanvi to call Rahul", {
        recentContext: [{ author: "Tanvi", body: "Unrelated historical context", timestamp: 1 }],
      }),
    );

    expect(reply).toBe(
      [
        "✅ 2 tasks added:",
        "• #1 Renew autter.dev domain — owner Sagnik · due 10 Nov 2026 · high priority",
        "• #2 Call Rahul about the pilot — owner Tanvi",
      ].join("\n"),
    );
    expect(llm.requests[0]?.toolChoice).toBe("required");
    expect(JSON.stringify(llm.requests[0]?.messages)).not.toContain("Unrelated historical context");
    expect(llm.requests[0]?.system).toContain("Cloudflare D1");
    const stored = await tasks.listOpen();
    expect(stored.tasks.map((task) => [task.title, task.area])).toEqual([
      ["Renew autter.dev domain", null],
      ["Call Rahul about the pilot", "Sales"],
    ]);
  });

  it("refuses to edit a guessed id until the task has been looked up", async () => {
    const tasks = taskStore();
    await tasks.create(
      [
        {
          title: "File GST return",
          notes: null,
          status: null,
          priority: null,
          owner: null,
          area: null,
          dueAt: null,
          tags: [],
        },
      ],
      { actor: "Sagnik", groupName: null, messageId: "seed" },
    );
    const llm = scriptedModel(
      toolTurn("u1", "update_tasks", { updates: [{ task_id: 1, status: "done" }] }),
      toolTurn("l1", "list_tasks", { text: "GST" }),
      toolTurn("u2", "update_tasks", { updates: [{ task_id: 1, status: "completed" }] }),
    );

    const reply = await assistantWith(llm, tasks).respond(
      request("@patch mark the GST filing as done"),
    );

    expect(reply).toBe("🎉 #1 File GST return — status: done");
    const guardOutput = llm.requests[1]?.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "u1",
    );
    expect(JSON.stringify(guardOutput)).toContain("Nothing was changed");
    expect((await tasks.get(1))?.status).toBe("done");
  });

  it("edits and deletes ids the founder named without an extra lookup", async () => {
    const tasks = taskStore();
    await tasks.create(
      [1, 2].map((n) => ({
        title: `Task ${n}`,
        notes: null,
        status: null,
        priority: null,
        owner: null,
        area: null,
        dueAt: null,
        tags: [],
      })),
      { actor: "Sagnik", groupName: null, messageId: "seed" },
    );
    const llm = scriptedModel(
      toolTurn(
        "u1",
        "update_tasks",
        { updates: [{ task_id: 1, owner: "Tanvi", notes: "Waiting on CA" }] },
        ["d1", "delete_tasks", { task_ids: [2] }],
      ),
    );

    const reply = await assistantWith(llm, tasks).respond(
      request("@patch give task #1 to Tanvi with a note 'Waiting on CA' and delete task 2"),
    );

    expect(reply).toBe(
      "✅ #1 Task 1 — owner: Tanvi; notes updated\n🗑️ Deleted #2 Task 2",
    );
    expect((await tasks.get(1))?.notes).toBe("Waiting on CA");
    expect(await tasks.get(2)).toBeNull();
  });

  it("answers the rest of a mixed request after confirming the write", async () => {
    const tasks = taskStore();
    const llm = scriptedModel(
      toolTurn(
        "c1",
        "create_tasks",
        { tasks: [{ title: "Draft November investor update" }] },
        ["l1", "list_tasks", { overdue_only: true }],
      ),
      textTurn("Nothing is overdue. Clean deck, Captain."),
    );

    const reply = await assistantWith(llm, tasks).respond(
      request("@patch add a task to draft the investor update, and what's overdue?"),
    );

    expect(reply).toBe(
      "✅ Task #1 added: Draft November investor update\n\nNothing is overdue. Clean deck, Captain.",
    );
  });

  it("sends invalid dates back to the model instead of storing them", async () => {
    const tasks = taskStore();
    const llm = scriptedModel(
      toolTurn("c1", "create_tasks", { tasks: [{ title: "Pay AWS", due_at: "next friday" }] }),
      toolTurn("c2", "create_tasks", { tasks: [{ title: "Pay AWS", due_at: "2026-11-06" }] }),
    );

    const reply = await assistantWith(llm, tasks).respond(
      request("@patch add a task to pay AWS next friday"),
    );

    expect(reply).toBe("✅ Task #1 added: Pay AWS — due 6 Nov 2026");
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("not an ISO 8601 date");
  });

  it("reports a D1 outage deterministically instead of letting the model guess", async () => {
    const failingTasks = {
      create: vi.fn().mockRejectedValue(new Error("D1 query failed (503)")),
    } as unknown as TaskStore;
    const llm = scriptedModel(toolTurn("c1", "create_tasks", { tasks: [{ title: "Book venue" }] }));

    const reply = await assistantWith(llm, failingTasks).respond(
      request("@patch add a task to book the venue"),
    );

    expect(reply).toContain("Cloudflare D1 task list didn't respond");
  });
});

describe("DiaAssistant spend log and Brain Dump", () => {
  it("logs every expense row through the Notion spend service", async () => {
    const addSpends = vi.fn().mockResolvedValue({
      paidBy: "Tanvi",
      results: [],
      createdCount: 2,
      duplicateCount: 0,
      failedCount: 0,
      createdAmount: 450,
    });
    const llm = scriptedModel(
      toolTurn("s1", "add_spends", {
        paid_by: "Tanvi",
        expenses: [
          { spend: "Chai", amount: 100, date: "2026-11-03", category: "Meals", payment_method: "UPI" },
          { spend: "Auto", amount: "350", date: "2026-11-03", category: "Travel" },
        ],
      }),
    );

    const reply = await assistantWith(llm, taskStore(), {
      notionSpend: { addSpends },
    }).respond(request("@patch add to spend log: chai 100 upi, auto 350", { requestedBy: "Tanvi" }));

    expect(reply).toBe("✅ Spend log updated: 2 entries · ₹450 · paid by Tanvi.");
    expect(addSpends.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ spend: "Chai", amount: 100, paymentMethod: "UPI", reimbursable: false }),
      expect.objectContaining({ spend: "Auto", amount: 350, paymentMethod: null, category: "Travel" }),
    ]);
  });

  it("appends to the Brain Dump and confirms deterministically", async () => {
    const appendBrainDump = vi.fn().mockResolvedValue(undefined);
    const llm = scriptedModel(
      toolTurn("b1", "append_brain_dump", {
        heading: "Onboarding idea",
        content: "Let users connect GitHub before signup.",
      }),
    );

    const reply = await assistantWith(llm, taskStore(), {
      notion: { canReadBrainDump: true, appendBrainDump },
    }).respond(request("@patch put this in the brain dump: GitHub connect before signup"));

    expect(reply).toBe("✅ Added to Brain Dump: Onboarding idea");
    expect(appendBrainDump).toHaveBeenCalledWith(
      { heading: "Onboarding idea", content: "Let users connect GitHub before signup." },
      { groupName: "Autter HQ", messageId: "msg-1", requestedBy: "Sagnik" },
    );
  });

  it("researches first, then saves the founder note and report together", async () => {
    const appendBrainDump = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ report: "## Findings\nTeams want proof.", searchesUsed: 2, sources: [] });
    const llm = scriptedModel(toolTurn("r1", "run_research", { question: "What do teams want?" }));

    const reply = await assistantWith(llm, taskStore(), {
      notion: { canReadBrainDump: true, appendBrainDump },
      researchAgent: { run },
    }).respond(request("@patch research what teams want and add it to the brain dump"));

    expect(llm.requests[0]?.toolChoice).toEqual({ name: "run_research" });
    expect(reply).toContain("Added your complete notes and Patch's research");
    expect(appendBrainDump.mock.calls[0]?.[0].content).toContain("## Findings\nTeams want proof.");
  });
});

describe("DiaAssistant media and limits", () => {
  it("sends images as vision input and documents as converted Markdown", async () => {
    const llm = scriptedModel(textTurn("Looks like an invoice from AWS."));

    await assistantWith(llm, taskStore()).respond(
      request("@patch what is this?", {
        attachments: [
          {
            kind: "image",
            mimeType: "image/png",
            fileName: "shot.png",
            dataBase64: "aGVsbG8=",
            sizeBytes: 5,
            transcript: null,
          },
          {
            kind: "pdf",
            mimeType: "application/pdf",
            fileName: "invoice.pdf",
            dataBase64: "aGVsbG8=",
            sizeBytes: 5,
            transcript: null,
            extractedText: "# Invoice\nAWS ₹4,200",
          },
        ],
      }),
    );

    const content = llm.requests[0]?.messages[0]?.content;
    expect(content).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=" },
    });
    expect(JSON.stringify(content)).toContain("AWS ₹4,200");
  });

  it("allows only one web search per message", async () => {
    const search = vi.fn().mockResolvedValue({ query: "q", results: [] });
    const llm = scriptedModel(
      toolTurn("w1", "search_web", { query: "GitHub news today" }),
      toolTurn("w2", "search_web", { query: "more GitHub news" }),
      textTurn("Quiet day on GitHub."),
    );

    const reply = await assistantWith(llm, taskStore(), { webSearch: { search } }).respond(
      request("@patch what's the latest GitHub news?"),
    );

    expect(reply).toBe("Quiet day on GitHub.");
    expect(search).toHaveBeenCalledOnce();
    expect(JSON.stringify(llm.requests[2]?.messages)).toContain("one-search limit");
  });

  it("creates a persistent reminder with a deterministic confirmation", async () => {
    const create = vi.fn().mockReturnValue({
      id: 9,
      groupId: "group@g.us",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      message: "Send the deck",
      dueAt: "2026-11-04T11:30:00.000Z",
      notifyBeforeMinutes: 10,
      repeatEveryMinutes: null,
      nextFireAt: "2026-11-04T11:20:00.000Z",
      phase: "pre_due",
    });
    const llm = scriptedModel(
      toolTurn("r1", "create_reminder", {
        message: "Send the deck",
        due_at: "2026-11-04T17:00:00+05:30",
      }),
    );

    const reply = await assistantWith(llm, taskStore(), { reminders: { create } }).respond(
      request("@patch remind me to send the deck at 5pm"),
    );

    expect(reply).toContain("⏰ Reminder #9 set for");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ notifyBeforeMinutes: 10, repeatEveryMinutes: null }),
    );
  });
});

describe("DiaAssistant group conversation", () => {
  it("detects questions about earlier discussion", () => {
    expect(isConversationRequest("what did we decide about pricing?")).toBe(true);
    expect(isConversationRequest("catch me up on the last day")).toBe(true);
    expect(isConversationRequest("turn this discussion into tasks")).toBe(true);
    expect(isConversationRequest("draft a launch tweet")).toBe(false);
  });

  it("reads only this group's log and answers from it", async () => {
    const conversation = new ConversationStore(":memory:");
    const now = Date.now();
    conversation.record({
      groupId: "group@g.us",
      messageId: "m1",
      author: "Tanvi",
      body: "Decided: per-repo pricing, starting December",
      fromBot: false,
      sentAtMs: now - 2 * 60 * 60 * 1_000,
    });
    conversation.record({
      groupId: "other@g.us",
      messageId: "x1",
      author: "Someone",
      body: "Unrelated group secret",
      fromBot: false,
      sentAtMs: now - 60 * 60 * 1_000,
    });
    const llm = scriptedModel(
      toolTurn("c1", "read_group_conversation", { hours_back: 24, text: "pricing" }),
      textTurn("Tanvi called it: per-repo pricing from December."),
    );

    const reply = await assistantWith(llm, taskStore(), { conversation }).respond(
      request("@patch what did we decide about pricing?"),
    );

    expect(reply).toBe("Tanvi called it: per-repo pricing from December.");
    expect(llm.requests[0]?.toolChoice).toBe("required");
    expect(llm.requests[0]?.system).toContain("Ground answers in what this group actually said");
    const toolOutput = JSON.stringify(llm.requests[1]?.messages.at(-1));
    expect(toolOutput).toContain("per-repo pricing");
    expect(toolOutput).not.toContain("Unrelated group secret");
    conversation.close();
  });

  it("turns the discussion into owned tasks after reading it", async () => {
    const conversation = new ConversationStore(":memory:");
    conversation.record({
      groupId: "group@g.us",
      messageId: "m1",
      author: "Tanvi",
      body: "I'll send Rahul the DPA tomorrow",
      fromBot: false,
      sentAtMs: Date.now() - 60_000,
    });
    const tasks = taskStore();
    const llm = scriptedModel(
      toolTurn("c1", "read_group_conversation", {}),
      toolTurn("t1", "create_tasks", {
        tasks: [{ title: "Send Rahul the DPA", owner: "Tanvi" }],
      }),
    );

    const reply = await assistantWith(llm, tasks, { conversation }).respond(
      request("@patch capture what we discussed as tasks"),
    );

    expect(reply).toBe("✅ Task #1 added: Send Rahul the DPA — owner Tanvi");
    conversation.close();
  });
});
