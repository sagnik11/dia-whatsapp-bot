import { describe, expect, it, vi } from "vitest";
import {
  NotionTaskService,
  boundBrainDumpMarkdown,
  brainDumpAppendMarkdown,
  buildTaskQueryFilter,
  resolveAssigneeId,
  taskSummaryFromPage,
} from "../src/notion.js";

const properties = {
  title: "Task name",
  status: "Status",
  dueDate: "Due date",
  assignee: "Assignee",
  priority: "Priority",
  taskType: "Task type",
};

describe("resolveAssigneeId", () => {
  const mapping = {
    sagnik: "user-1",
    "alex smith": "user-2",
  };

  it("uses the default for an omitted assignee", () => {
    expect(resolveAssigneeId(null, "default-user", mapping)).toBe("default-user");
  });

  it("uses the default for a self-reference", () => {
    expect(resolveAssigneeId("Me", "default-user", mapping)).toBe("default-user");
  });

  it("matches configured names case-insensitively", () => {
    expect(resolveAssigneeId("Alex Smith", "default-user", mapping)).toBe("user-2");
  });

  it("leaves an unknown person unassigned", () => {
    expect(resolveAssigneeId("Unknown", "default-user", mapping)).toBeUndefined();
  });
});

describe("buildTaskQueryFilter", () => {
  it("combines title, status, and due-date filters", () => {
    expect(
      buildTaskQueryFilter(
        {
          titleContains: "proposal",
          status: "Not started",
          dueFrom: "2026-08-10",
          dueTo: "2026-08-17",
          limit: 10,
        },
        properties,
      ),
    ).toEqual({
      and: [
        { property: "Task name", title: { contains: "proposal" } },
        { property: "Status", status: { equals: "Not started" } },
        { property: "Due date", date: { on_or_after: "2026-08-10" } },
        { property: "Due date", date: { on_or_before: "2026-08-17" } },
      ],
    });
  });
});

describe("taskSummaryFromPage", () => {
  it("returns only the task fields exposed to the model", () => {
    const page = {
      object: "page",
      id: "page-1",
      url: "https://notion.so/page-1",
      properties: {
        "Task name": {
          type: "title",
          title: [{ plain_text: "Send proposal" }],
        },
        Status: { type: "status", status: { name: "Not started" } },
        "Due date": { type: "date", date: { start: "2026-08-12" } },
        Assignee: {
          type: "people",
          people: [{ name: "Sagnik Ghosh" }],
        },
        Priority: { type: "select", select: { name: "High" } },
        "Task type": {
          type: "multi_select",
          multi_select: [{ name: "Tech" }],
        },
      },
    };

    expect(taskSummaryFromPage(page as never, properties)).toEqual({
      id: "page-1",
      url: "https://notion.so/page-1",
      title: "Send proposal",
      status: "Not started",
      dueAt: "2026-08-12",
      assignees: ["Sagnik Ghosh"],
      priority: "High",
      taskTypes: ["Tech"],
    });
  });
});

describe("Notion Brain Dump reads", () => {
  it("retrieves only the configured page as markdown", async () => {
    const retrieveMarkdown = vi.fn().mockResolvedValue({
      object: "page_markdown",
      id: "brain-page",
      markdown: "# Brain Dump\n\nAn onboarding idea",
      truncated: false,
      unknown_block_ids: [],
    });
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      brainDumpPageId: "brain-page",
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: {},
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { pages: { retrieveMarkdown } },
    });

    await expect(service.readBrainDump()).resolves.toEqual({
      pageId: "brain-page",
      markdown: "# Brain Dump\n\nAn onboarding idea",
      truncated: false,
    });
    expect(retrieveMarkdown).toHaveBeenCalledWith({
      page_id: "brain-page",
      include_transcript: false,
    });
  });

  it("bounds large pages before exposing them to the model", () => {
    const result = boundBrainDumpMarkdown("x".repeat(12_001));

    expect(result.truncated).toBe(true);
    expect(result.markdown).toContain("[Content truncated by Captain Patch]");
    expect(result.markdown).not.toContain("x".repeat(12_001));
  });
});

describe("Notion Brain Dump appends", () => {
  it("appends a source-attributed note at the end of only the configured page", async () => {
    const updateMarkdown = vi.fn().mockResolvedValue({
      object: "page_markdown",
      id: "brain-page",
      markdown: "existing content",
      truncated: false,
      unknown_block_ids: [],
    });
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      brainDumpPageId: "brain-page",
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: {},
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { pages: { updateMarkdown } },
    });

    const result = await service.appendBrainDump(
      { heading: "Onboarding", content: "Make the first review memorable." },
      {
        groupName: "Autter founders",
        requestedBy: "Tanvi",
        messageId: "message-4",
      },
    );

    expect(result).toMatchObject({ pageId: "brain-page", heading: "Onboarding" });
    expect(updateMarkdown).toHaveBeenCalledWith({
      page_id: "brain-page",
      type: "insert_content",
      insert_content: {
        content: expect.stringContaining("## Onboarding"),
        position: { type: "end" },
      },
    });
    expect(updateMarkdown.mock.calls[0]?.[0].insert_content.content).toContain(
      "Make the first review memorable.",
    );
    expect(updateMarkdown.mock.calls[0]?.[0].insert_content.content).toContain(
      "Autter founders · Tanvi",
    );
  });

  it("formats a heading-free WhatsApp note", () => {
    expect(
      brainDumpAppendMarkdown(
        { heading: null, content: "  Keep this idea.  " },
        { groupName: "Autter", requestedBy: "Sagnik", messageId: "message-5" },
      ),
    ).toContain("## WhatsApp note\n\nKeep this idea.");
  });
});
