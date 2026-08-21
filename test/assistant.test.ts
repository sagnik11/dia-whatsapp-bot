import { describe, expect, it, vi } from "vitest";
import {
  DiaAssistant,
  formatSpendConfirmation,
  formatTaskConfirmation,
  isExplicitReminderCancelRequest,
  isExplicitReminderCompleteRequest,
  isExplicitReminderCreateRequest,
  isExplicitReminderListRequest,
  isExplicitBrainDumpAppendRequest,
  isExplicitBrainDumpRequest,
  isExplicitKnowledgeRequest,
  isExplicitResearchRequest,
  isExplicitSpendCreateRequest,
  isExplicitSpendReadRequest,
  isExplicitTaskReadRequest,
  isExplicitTaskRequest,
  isExplicitTaskUpdateRequest,
  isExplicitWebSearchRequest,
} from "../src/assistant.js";

describe("isExplicitTaskRequest", () => {
  it.each([
    "add a task to send the proposal",
    "create a high priority task for tomorrow",
    "turn the quoted message into a task",
  ])("detects an explicit task command: %s", (message) => {
    expect(isExplicitTaskRequest(message)).toBe(true);
  });

  it("does not mistake a question about tasks for a creation command", () => {
    expect(isExplicitTaskRequest("what tasks should I add next?")).toBe(false);
  });
});

describe("founder spend command detection", () => {
  it("detects bulk spend writes without confusing them with reads", () => {
    const message = "add to daily spend log: Expenses by Tanvi: 12th aug chai 100rs upi";
    expect(isExplicitSpendCreateRequest(message)).toBe(true);
    expect(isExplicitSpendReadRequest(message)).toBe(false);
  });

  it("detects spend-log questions", () => {
    expect(isExplicitSpendReadRequest("how much did Tanvi spend this month?"))
      .toBe(true);
  });
});

describe("isExplicitTaskReadRequest", () => {
  it.each([
    "show me my tasks",
    "what tasks are pending?",
    "which tasks are due this week?",
    "what's due tomorrow?",
  ])("detects a task tracker query: %s", (message) => {
    expect(isExplicitTaskReadRequest(message)).toBe(true);
  });

  it("does not read Notion for a planning question", () => {
    expect(isExplicitTaskReadRequest("what tasks should I add next?")).toBe(false);
  });
});

describe("task and reminder command detection", () => {
  it("detects an existing-task update", () => {
    expect(
      isExplicitTaskUpdateRequest(
        "shift the intern feedback task from completed to in progress and assign it to Tanvi",
      ),
    ).toBe(true);
    expect(
      isExplicitTaskUpdateRequest(
        "edit the launch task page and append the customer feedback as a note",
      ),
    ).toBe(true);
  });

  it("detects reminder creation, listing, completion, and cancellation", () => {
    expect(isExplicitReminderCreateRequest("remind me to send the proposal at 4"))
      .toBe(true);
    expect(isExplicitReminderListRequest("show my reminders")).toBe(true);
    expect(
      isExplicitReminderCompleteRequest(
        "mark reminder number 7 as completed",
      ),
    ).toBe(true);
    expect(isExplicitReminderCompleteRequest("which reminders are completed?")).toBe(
      false,
    );
    expect(isExplicitReminderCancelRequest("cancel reminder 4")).toBe(true);
  });
});

describe("formatTaskConfirmation", () => {
  it("confirms the created task with its Notion URL", () => {
    expect(
      formatTaskConfirmation([
        { id: "page-id", title: "Send proposal", url: "https://notion.so/page" },
      ]),
    ).toBe("✅ Task added: Send proposal\nhttps://notion.so/page");
  });
});

describe("formatSpendConfirmation", () => {
  it("confirms the batch count, INR total, and payer", () => {
    expect(
      formatSpendConfirmation({
        paidBy: "Tanvi",
        results: [],
        createdCount: 9,
        duplicateCount: 0,
        failedCount: 0,
        createdAmount: 6471,
      }),
    ).toBe("✅ Spend log updated: 9 entries · ₹6,471 · paid by Tanvi.");
  });
});

describe("DiaAssistant founder spend log", () => {
  it("forces a nine-row spend write and returns a deterministic confirmation", async () => {
    const expenses = [100, 253, 4783, 148, 185, 219, 215, 333, 235].map(
      (amount, index) => ({
        spend: `Expense ${index + 1}`,
        amount,
        date: index < 2 ? "2026-08-12" : "2026-08-13",
        category: index === 0 ? "Meals" : "Other",
        payment_method: "UPI",
        vendor: null,
        notes: null,
        reimbursable: false,
      }),
    );
    const addSpends = vi.fn().mockResolvedValue({
      paidBy: "Tanvi",
      results: expenses.map((expense, index) => ({
        index,
        spend: expense.spend,
        amount: expense.amount,
        date: expense.date,
        status: "created",
        id: `page-${index}`,
        url: null,
        error: null,
      })),
      createdCount: 9,
      duplicateCount: 0,
      failedCount: 0,
      createdAmount: 6471,
    });
    const responsesCreate = vi.fn().mockResolvedValueOnce({
      output: [
        {
          type: "function_call",
          name: "add_notion_spends",
          call_id: "spend-create",
          arguments: JSON.stringify({ paid_by: "Tanvi", expenses }),
        },
      ],
      output_text: "",
    });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: {} as never,
      notionSpend: { addSpends } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "spend-message",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      body: "@patch add to daily spend log: Expenses by Tanvi: 9 entries",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toBe("✅ Spend log updated: 9 entries · ₹6,471 · paid by Tanvi.");
    expect(addSpends).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ paidBy: "Tanvi" })]),
      {
        messageId: "spend-message",
        groupName: "Autter",
        requestedBy: "Sagnik",
      },
    );
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "add_notion_spends" },
    });
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

describe("DiaAssistant task reads", () => {
  it("returns Notion task results to the model for a final answer", async () => {
    const listTasks = vi.fn().mockResolvedValue({
      tasks: [
        {
          id: "page-1",
          url: "https://notion.so/page-1",
          title: "Send proposal",
          status: "Not started",
          dueAt: "2026-08-12",
          assignees: ["Sagnik"],
          priority: "High",
          taskTypes: ["Marketing"],
        },
      ],
      hasMore: false,
    });
    const responsesCreate = vi.fn().mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "list_notion_tasks",
            call_id: "call-1",
            arguments: JSON.stringify({
              title_contains: null,
              status: null,
              due_from: "2026-08-10",
              due_to: "2026-08-17",
              limit: 10,
            }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [],
        output_text: "Send proposal is due Wednesday.",
      });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Dia",
      timezone: "Asia/Kolkata",
      notion: { listTasks } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Test group",
      messageId: "message-1",
      requestedBy: "Sagnik",
      requestedById: "919999999999@c.us",
      body: "which tasks are due this week?",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toBe("Send proposal is due Wednesday.");
    expect(listTasks).toHaveBeenCalledWith({
      titleContains: null,
      status: null,
      dueFrom: "2026-08-10",
      dueTo: "2026-08-17",
      limit: 10,
    });
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "list_notion_tasks" },
    });
    expect(responsesCreate.mock.calls[1]?.[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: expect.stringContaining("Send proposal"),
    });
    expect(responsesCreate.mock.calls[1]?.[0]).not.toHaveProperty("tool_choice");
  });
});

describe("DiaAssistant persistent Autter memory", () => {
  it("recalls memory before answering and marks it subordinate to live data", async () => {
    const recall = vi.fn().mockResolvedValue({
      staticProfile: ["Sagnik and Tanvi are equal co-founders"],
      dynamicProfile: ["Preparing the Autter launch"],
      relevantMemories: ["Tanvi owns launch marketing"],
    });
    const responsesCreate = vi.fn().mockResolvedValueOnce({
      output: [],
      output_text: "Tanvi owns launch marketing.",
    });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: {} as never,
      memory: { recall } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const assistantRequest = {
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "memory-question",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      body: "who owns launch marketing?",
      quotedMessage: null,
      recentContext: [],
    };
    const reply = await assistant.respond(assistantRequest);

    expect(reply).toBe("Tanvi owns launch marketing.");
    expect(recall).toHaveBeenCalledWith(assistantRequest);
    expect(responsesCreate.mock.calls[0]?.[0].input).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          {
            type: "input_text",
            text: expect.stringContaining("Tanvi owns launch marketing"),
          },
        ]),
      }),
    );
    expect(responsesCreate.mock.calls[0]?.[0].instructions).toContain(
      "fresh tool results always override recalled memory",
    );
  });
});

describe("DiaAssistant web search", () => {
  it("uses one search and gives its sources back to the model", async () => {
    const search = vi.fn().mockResolvedValue({
      query: "latest Autter news",
      results: [
        {
          title: "Autter",
          url: "https://autter.dev/",
          content: "Autter is the assurance layer for the AI coding era.",
        },
      ],
    });
    const responsesCreate = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "search_web",
            call_id: "search-1",
            arguments: JSON.stringify({
              query: "latest Autter news",
              topic: "news",
            }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [],
        output_text: "The harbour is busy. https://autter.dev/",
      });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: {} as never,
      webSearch: { search } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "message-2",
      requestedBy: "Tanvi",
      requestedById: "919999999998@c.us",
      body: "what is the latest Autter news?",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toContain("https://autter.dev/");
    expect(search).toHaveBeenCalledOnce();
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "search_web" },
      instructions: expect.stringContaining(
        "Sagnik Ghosh and Tanvi are equal co-founders",
      ),
    });
    expect(responsesCreate.mock.calls[1]?.[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "search-1",
      output: expect.stringContaining("https://autter.dev/"),
    });
    expect(responsesCreate.mock.calls[1]?.[0]).not.toHaveProperty("tool_choice");
  });
});

describe("DiaAssistant delegated research", () => {
  it("forces one bounded research run and returns its evidence to Patch", async () => {
    const run = vi.fn().mockResolvedValue({
      report: "## Summary\nPublish on Hacker News. https://news.ycombinator.com/",
      searchesUsed: 3,
      sources: [
        { title: "Hacker News", url: "https://news.ycombinator.com/" },
      ],
    });
    const responsesCreate = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "run_research",
            call_id: "research-1",
            arguments: JSON.stringify({
              question: "Where should Autter publish its launch?",
              context: "Developer audience",
            }),
          },
        ],
        output_text: "",
      });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: {} as never,
      researchAgent: { run } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "message-research",
      requestedBy: "Tanvi",
      requestedById: "tanvi@c.us",
      body: "research the best places to publish our launch",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toContain("https://news.ycombinator.com/");
    expect(run).toHaveBeenCalledWith({
      question: "Where should Autter publish its launch?",
      context: "Developer audience",
      requestedBy: "Tanvi",
    });
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "run_research" },
    });
    expect(responsesCreate).toHaveBeenCalledOnce();
  });

  it("researches a long founder note and appends the complete note and report separately", async () => {
    const longQuestion = `Research this fully: ${"founder context ".repeat(80)}`;
    const longContext = "background ".repeat(300);
    const report = `## Findings\n\n${"evidence and recommendation ".repeat(300)}`;
    const run = vi.fn().mockResolvedValue({
      report,
      searchesUsed: 3,
      sources: [{ title: "Source", url: "https://example.com/source" }],
    });
    const appendBrainDump = vi.fn().mockResolvedValue({
      pageId: "brain-page",
      heading: "Founder notes and Patch research",
      charactersAdded: 15_000,
    });
    const responsesCreate = vi.fn().mockResolvedValueOnce({
      output: [
        {
          type: "function_call",
          name: "run_research",
          call_id: "research-brain-dump",
          arguments: JSON.stringify({
            question: longQuestion,
            context: longContext,
          }),
        },
      ],
      output_text: "",
    });
    const founderMessage = [
      "These are my detailed launch ideas.",
      "founder note ".repeat(500),
      "Research them and add my notes and your research separately to the Brain Dump.",
    ].join("\n");
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: { canReadBrainDump: true, appendBrainDump } as never,
      researchAgent: { run } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "large-brain-dump-research",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      body: founderMessage,
      quotedMessage: "Additional quoted founder detail.",
      recentContext: [],
    });

    expect(reply).toBe(
      "✅ Added your complete notes and Patch's research to Brain Dump as separate sections.",
    );
    expect(run).toHaveBeenCalledWith({
      question: longQuestion,
      context: longContext,
      requestedBy: "Sagnik",
    });
    expect(appendBrainDump).toHaveBeenCalledWith(
      {
        heading: "Founder notes and Patch research",
        content: expect.stringMatching(
          /### Founder notes[\s\S]*Additional quoted founder detail\.[\s\S]*### Patch research/,
        ),
      },
      {
        groupName: "Autter",
        messageId: "large-brain-dump-research",
        requestedBy: "Sagnik",
      },
    );
    expect(appendBrainDump.mock.calls[0]?.[0].content).toContain(founderMessage);
    expect(appendBrainDump.mock.calls[0]?.[0].content).toContain(report.trim());
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "run_research" },
    });
    expect(responsesCreate).toHaveBeenCalledOnce();
  });

  it("can append delegated findings to one exactly matched Notion task", async () => {
    const matchedTask = {
      id: "publishing-page",
      url: "https://notion.so/publishing-page",
      title: "Publishing",
      status: "In progress",
      dueAt: null,
      assignees: ["Sagnik"],
      priority: null,
      taskTypes: ["Marketing"],
    };
    const listTasks = vi.fn().mockResolvedValue({
      tasks: [matchedTask],
      hasMore: false,
    });
    const run = vi.fn().mockResolvedValue({
      report: "## Findings\nTry Show HN. https://news.ycombinator.com/",
      searchesUsed: 2,
      sources: [
        { title: "Hacker News", url: "https://news.ycombinator.com/" },
      ],
    });
    const updateTask = vi.fn().mockResolvedValue({
      id: matchedTask.id,
      url: matchedTask.url,
      title: matchedTask.title,
      status: null,
      dueAt: null,
      assignee: null,
      priority: null,
      taskTypes: null,
      clearedFields: [],
      pageContentMode: "append",
    });
    const responsesCreate = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "list_notion_tasks",
            call_id: "task-search",
            arguments: JSON.stringify({
              title_contains: "Publishing",
              status: null,
              due_from: null,
              due_to: null,
              limit: 10,
            }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "run_research",
            call_id: "task-research",
            arguments: JSON.stringify({
              question: "Where should Autter publish its launch?",
              context: "Append the result to the Publishing task",
            }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "update_notion_task",
            call_id: "task-update",
            arguments: JSON.stringify({
              page_id: matchedTask.id,
              matched_title: matchedTask.title,
              new_title: null,
              status: null,
              due_at: null,
              assignee: null,
              priority: null,
              task_types: null,
              clear_fields: [],
              page_content_mode: "append",
              page_content:
                "## Research\nTry Show HN. https://news.ycombinator.com/",
            }),
          },
        ],
        output_text: "",
      });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: { listTasks, updateTask } as never,
      researchAgent: { run } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "research-task-message",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      body: "research publishing channels and append it to the publishing task",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toContain("✅ Updated task: Publishing");
    expect(run).toHaveBeenCalledOnce();
    expect(updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: matchedTask.id,
        pageContentMode: "append",
        pageContent: expect.stringContaining("https://news.ycombinator.com/"),
      }),
    );
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "list_notion_tasks" },
    });
  });
});

describe("DiaAssistant Brain Dump reads", () => {
  it("reads the configured page and gives its bounded content to the model", async () => {
    const readBrainDump = vi.fn().mockResolvedValue({
      pageId: "brain-page",
      markdown: "# Feedback\nMake the first review memorable.",
      truncated: false,
    });
    const responsesCreate = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "read_brain_dump",
            call_id: "brain-1",
            arguments: JSON.stringify({ query: "summarize the Brain Dump" }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [],
        output_text: "The main idea is to make the first review memorable.",
      });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: { canReadBrainDump: true, readBrainDump } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "message-3",
      requestedBy: "Sagnik",
      requestedById: "919999999999@c.us",
      body: "summarize the Brain Dump",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toContain("first review memorable");
    expect(readBrainDump).toHaveBeenCalledOnce();
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "read_brain_dump" },
    });
    expect(responsesCreate.mock.calls[1]?.[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "brain-1",
      output: expect.stringContaining("Make the first review memorable"),
    });
    expect(responsesCreate.mock.calls[1]?.[0]).not.toHaveProperty("tool_choice");
  });
});

describe("DiaAssistant Brain Dump appends", () => {
  it("accepts a large note, appends once, and returns a deterministic confirmation", async () => {
    const completeNote = `Make the first review memorable.\n\n${"Detailed founder context. ".repeat(300)}`;
    const appendBrainDump = vi.fn().mockResolvedValue({
      pageId: "brain-page",
      heading: "Onboarding",
      charactersAdded: completeNote.length,
    });
    const responsesCreate = vi.fn().mockResolvedValueOnce({
      output: [
        {
          type: "function_call",
          name: "append_brain_dump",
          call_id: "append-1",
          arguments: JSON.stringify({
            heading: "Onboarding",
            content: completeNote,
          }),
        },
      ],
      output_text: "",
    });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: {
        canReadBrainDump: true,
        appendBrainDump,
      } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "message-4",
      requestedBy: "Tanvi",
      requestedById: "919999999998@c.us",
      body: "add this onboarding feedback to the Brain Dump",
      quotedMessage: "Make the first review memorable.",
      recentContext: [],
    });

    expect(reply).toBe("✅ Added to Brain Dump: Onboarding");
    expect(appendBrainDump).toHaveBeenCalledWith(
      {
        heading: "Onboarding",
        content: completeNote,
      },
      {
        groupName: "Autter",
        messageId: "message-4",
        requestedBy: "Tanvi",
      },
    );
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "append_brain_dump" },
    });
  });
});

describe("DiaAssistant Notion knowledge", () => {
  it("searches, reads only a matched resource, and answers from its content", async () => {
    const searchKnowledge = vi.fn().mockResolvedValue({
      results: [
        {
          id: "goals-page",
          type: "page",
          title: "Company Goals - 2026",
          url: "https://notion.so/goals-page",
          lastEditedTime: "2026-08-10T12:00:00.000Z",
        },
      ],
      hasMore: false,
    });
    const readKnowledgeResource = vi.fn().mockResolvedValue({
      id: "goals-page",
      type: "page",
      markdown: "# Product\nShip all five enforcement pillars.",
      truncated: false,
    });
    const responsesCreate = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "search_notion_knowledge",
            call_id: "knowledge-search-1",
            arguments: JSON.stringify({ query: "Company Goals", limit: 5 }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "read_notion_knowledge",
            call_id: "knowledge-read-1",
            arguments: JSON.stringify({
              resource_id: "goals-page",
              resource_type: "page",
            }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [],
        output_text: "Our product goal is to ship all five enforcement pillars.",
      });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: {
        canReadKnowledge: true,
        searchKnowledge,
        readKnowledgeResource,
      } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "message-6",
      requestedBy: "Sagnik",
      requestedById: "919999999999@c.us",
      body: "search Autter HQ for our company goals",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toContain("five enforcement pillars");
    expect(searchKnowledge).toHaveBeenCalledWith("Company Goals", 5);
    expect(readKnowledgeResource).toHaveBeenCalledWith("goals-page", "page");
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "search_notion_knowledge" },
    });
    expect(responsesCreate.mock.calls[2]?.[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "knowledge-read-1",
      output: expect.stringContaining("Ship all five enforcement pillars"),
    });
  });

  it("rejects a resource ID that was not returned by this request's search", async () => {
    const readKnowledgeResource = vi.fn();
    const responsesCreate = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "read_notion_knowledge",
            call_id: "unmatched-read",
            arguments: JSON.stringify({
              resource_id: "untrusted-page-id",
              resource_type: "page",
            }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [],
        output_text: "I couldn't access that unsearched resource.",
      });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: { canReadKnowledge: true, readKnowledgeResource } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "message-7",
      requestedBy: "Sagnik",
      requestedById: "919999999999@c.us",
      body: "read this Notion page",
      quotedMessage: null,
      recentContext: [],
    });

    expect(readKnowledgeResource).not.toHaveBeenCalled();
    expect(responsesCreate.mock.calls[1]?.[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "unmatched-read",
      output: expect.stringContaining("not returned by the Notion knowledge search"),
    });
  });
});

describe("DiaAssistant task updates", () => {
  it("looks up an exact task before editing it", async () => {
    const listTasks = vi.fn().mockResolvedValue({
      tasks: [
        {
          id: "task-page",
          url: "https://notion.so/task-page",
          title: "Feedbacks from Intern Applications",
          status: "Completed",
          dueAt: null,
          assignees: ["Tanvi Bhole"],
          priority: null,
          taskTypes: [],
        },
      ],
      hasMore: false,
    });
    const updateTask = vi.fn().mockResolvedValue({
      id: "task-page",
      url: "https://notion.so/task-page",
      title: "Feedbacks from Intern Applications",
      status: "In progress",
      dueAt: null,
      assignee: "Tanvi",
      priority: null,
      taskTypes: null,
      clearedFields: [],
      pageContentMode: null,
    });
    const responsesCreate = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "list_notion_tasks",
            call_id: "task-search",
            arguments: JSON.stringify({
              title_contains: "Feedbacks from Intern Applications",
              status: null,
              due_from: null,
              due_to: null,
              limit: 10,
            }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "update_notion_task",
            call_id: "truncated-task-update",
            arguments:
              '{"page_id":"task-page","matched_title":"Feedbacks from Intern Applications","page_content":"unfinished',
          },
        ],
        output_text: "",
        incomplete_details: { reason: "max_output_tokens" },
      })
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "update_notion_task",
            call_id: "task-update",
            arguments: JSON.stringify({
              page_id: "task-page",
              matched_title: "Feedbacks from Intern Applications",
              new_title: null,
              status: "In progress",
              due_at: null,
              assignee: "Tanvi",
              priority: null,
              task_types: null,
              clear_fields: [],
              page_content_mode: null,
              page_content: null,
            }),
          },
        ],
        output_text: "",
      });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: { listTasks, updateTask } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "message-update",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      body: "shift the intern feedback task from completed to in progress and assign it to Tanvi",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toContain("✅ Updated task: Feedbacks from Intern Applications");
    expect(updateTask).toHaveBeenCalledWith({
      pageId: "task-page",
      title: "Feedbacks from Intern Applications",
      newTitle: null,
      status: "In progress",
      dueAt: null,
      assignee: null,
      priority: null,
      taskTypes: null,
      clearFields: [],
      pageContentMode: null,
      pageContent: null,
    });
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "list_notion_tasks" },
    });
    expect(responsesCreate.mock.calls[0]?.[0]).not.toHaveProperty(
      "max_output_tokens",
    );
    expect(responsesCreate).toHaveBeenCalledTimes(3);
    expect(responsesCreate.mock.calls[2]?.[0].input).toContainEqual({
      type: "function_call_output",
      call_id: "truncated-task-update",
      output: expect.stringContaining("truncated or malformed"),
    });
  });
});

describe("DiaAssistant reminders", () => {
  it("creates a persistent reminder with advance and due notifications", async () => {
    const create = vi.fn().mockReturnValue({
      id: 12,
      groupId: "group@g.us",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      message: "Send the proposal",
      dueAt: "2026-08-11T11:30:00.000Z",
      notifyBeforeMinutes: 10,
      repeatEveryMinutes: null,
      nextFireAt: "2026-08-11T11:20:00.000Z",
      phase: "pre_due",
    });
    const responsesCreate = vi.fn().mockResolvedValueOnce({
      output: [
        {
          type: "function_call",
          name: "create_reminder",
          call_id: "reminder-create",
          arguments: JSON.stringify({
            message: "Send the proposal",
            due_at: "2026-08-11T17:00:00+05:30",
            notify_before_minutes: 10,
            repeat_every_minutes: null,
          }),
        },
      ],
      output_text: "",
    });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: {} as never,
      reminders: { create } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "message-reminder",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      body: "remind me to send the proposal at 5 PM",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toContain("⏰ Reminder #12 set");
    expect(reply).toContain("10 min before, when due");
    expect(create).toHaveBeenCalledWith({
      groupId: "group@g.us",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      sourceMessageId: "message-reminder",
      message: "Send the proposal",
      dueAt: "2026-08-11T17:00:00+05:30",
      notifyBeforeMinutes: 10,
      repeatEveryMinutes: null,
    });
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "create_reminder" },
    });
  });

  it("marks an active reminder completed and stops its future notifications", async () => {
    const complete = vi.fn().mockReturnValue(true);
    const responsesCreate = vi.fn().mockResolvedValueOnce({
      output: [
        {
          type: "function_call",
          name: "complete_reminder",
          call_id: "reminder-complete",
          arguments: JSON.stringify({ reminder_id: 7 }),
        },
      ],
      output_text: "",
    });
    const assistant = new DiaAssistant({
      azureApiKey: "test-key",
      azureBaseUrl: "https://resource.openai.azure.com/openai/v1/",
      deployment: "test-deployment",
      botName: "Captain Patch",
      timezone: "Asia/Kolkata",
      notion: {} as never,
      reminders: { complete } as never,
      logger: { warn: vi.fn() } as never,
    });
    Object.assign(assistant as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const reply = await assistant.respond({
      groupId: "group@g.us",
      groupName: "Autter",
      messageId: "message-reminder-complete",
      requestedBy: "Sagnik",
      requestedById: "sagnik@c.us",
      body: "mark reminder number 7 as completed",
      quotedMessage: null,
      recentContext: [],
    });

    expect(reply).toBe(
      "✅ Reminder #7 marked completed. Future notifications have been stopped.",
    );
    expect(complete).toHaveBeenCalledWith(7, "group@g.us");
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "complete_reminder" },
    });
  });
});
