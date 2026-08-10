import { describe, expect, it, vi } from "vitest";
import {
  DiaAssistant,
  formatTaskConfirmation,
  isExplicitTaskReadRequest,
  isExplicitTaskRequest,
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

describe("formatTaskConfirmation", () => {
  it("confirms the created task with its Notion URL", () => {
    expect(
      formatTaskConfirmation([
        { id: "page-id", title: "Send proposal", url: "https://notion.so/page" },
      ]),
    ).toBe("✅ Task added: Send proposal\nhttps://notion.so/page");
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
  });
});
