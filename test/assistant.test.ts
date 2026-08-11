import { describe, expect, it, vi } from "vitest";
import {
  DiaAssistant,
  formatTaskConfirmation,
  isExplicitReminderCancelRequest,
  isExplicitReminderCreateRequest,
  isExplicitReminderListRequest,
  isExplicitBrainDumpAppendRequest,
  isExplicitBrainDumpRequest,
  isExplicitKnowledgeRequest,
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
  });

  it("detects reminder creation, listing, and cancellation", () => {
    expect(isExplicitReminderCreateRequest("remind me to send the proposal at 4"))
      .toBe(true);
    expect(isExplicitReminderListRequest("show my reminders")).toBe(true);
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
    const responsesCreate = vi
      .fn()
      .mockResolvedValueOnce({
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
      gatewayApiKey: "test-key",
      gatewayBaseUrl: "https://example.com/v1",
      model: "azure/test-model",
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
      gatewayApiKey: "test-key",
      gatewayBaseUrl: "https://example.com/v1",
      model: "azure/test-model",
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
      gatewayApiKey: "test-key",
      gatewayBaseUrl: "https://example.com/v1",
      model: "azure/test-model",
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
  it("appends once and returns a deterministic confirmation", async () => {
    const appendBrainDump = vi.fn().mockResolvedValue({
      pageId: "brain-page",
      heading: "Onboarding",
      charactersAdded: 120,
    });
    const responsesCreate = vi.fn().mockResolvedValueOnce({
      output: [
        {
          type: "function_call",
          name: "append_brain_dump",
          call_id: "append-1",
          arguments: JSON.stringify({
            heading: "Onboarding",
            content: "Make the first review memorable.",
          }),
        },
      ],
      output_text: "",
    });
    const assistant = new DiaAssistant({
      gatewayApiKey: "test-key",
      gatewayBaseUrl: "https://example.com/v1",
      model: "azure/test-model",
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
        content: "Make the first review memorable.",
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
      gatewayApiKey: "test-key",
      gatewayBaseUrl: "https://example.com/v1",
      model: "azure/test-model",
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
      gatewayApiKey: "test-key",
      gatewayBaseUrl: "https://example.com/v1",
      model: "azure/test-model",
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
  it("looks up an exact task before changing its status and assignee", async () => {
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
      assignee: "Tanvi",
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
            call_id: "task-update",
            arguments: JSON.stringify({
              page_id: "task-page",
              title: "Feedbacks from Intern Applications",
              status: "In progress",
              assignee: "Tanvi",
            }),
          },
        ],
        output_text: "",
      });
    const assistant = new DiaAssistant({
      gatewayApiKey: "test-key",
      gatewayBaseUrl: "https://example.com/v1",
      model: "azure/test-model",
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
      status: "In progress",
      assignee: null,
    });
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "list_notion_tasks" },
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
      gatewayApiKey: "test-key",
      gatewayBaseUrl: "https://example.com/v1",
      model: "azure/test-model",
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
});
