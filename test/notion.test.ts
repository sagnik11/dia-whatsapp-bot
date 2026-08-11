import { describe, expect, it, vi } from "vitest";
import {
  NotionTaskService,
  boundBrainDumpMarkdown,
  brainDumpAppendMarkdown,
  buildTaskQueryFilter,
  isIncompleteTaskStatus,
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

describe("Notion task collaboration", () => {
  it("reads and creates task comments", async () => {
    const list = vi.fn().mockResolvedValue({
      results: [
        {
          id: "comment-1",
          display_name: { resolved_name: "Tanvi" },
          created_by: { id: "user-2" },
          created_time: "2026-08-11T10:00:00.000Z",
          rich_text: [{ plain_text: "Please tighten the positioning." }],
        },
      ],
    });
    const create = vi.fn().mockResolvedValue({ id: "comment-2" });
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: {},
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { comments: { list, create } },
    });

    await expect(service.listTaskComments("page-1", 10)).resolves.toEqual([
      {
        id: "comment-1",
        author: "Tanvi",
        createdAt: "2026-08-11T10:00:00.000Z",
        text: "Please tighten the positioning.",
      },
    ]);
    await service.addTaskComment("page-1", "Looks good.", "Sagnik");
    expect(create).toHaveBeenCalledWith({
      parent: { page_id: "page-1" },
      markdown: "Looks good.",
      display_name: { type: "custom", custom: { name: "Sagnik" } },
    });
  });

  it("uploads an image and appends it to an exact task page", async () => {
    const createUpload = vi.fn().mockResolvedValue({ id: "upload-1" });
    const sendUpload = vi.fn().mockResolvedValue({
      id: "upload-1",
      status: "uploaded",
    });
    const updateMarkdown = vi.fn().mockResolvedValue({});
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: {},
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: {
        fileUploads: { create: createUpload, send: sendUpload },
        pages: { updateMarkdown },
      },
    });

    await expect(
      service.attachMediaToTask("page-1", {
        kind: "image",
        mimeType: "image/png",
        fileName: "launch.png",
        dataBase64: Buffer.from("image").toString("base64"),
        sizeBytes: 5,
        transcript: null,
      }),
    ).resolves.toEqual({
      pageId: "page-1",
      fileName: "launch.png",
      fileUploadId: "upload-1",
    });
    expect(updateMarkdown).toHaveBeenCalledWith({
      page_id: "page-1",
      type: "insert_content",
      insert_content: {
        content: "![launch\\.png](file-upload://upload-1)",
        position: { type: "end" },
      },
    });
  });
});

describe("Notion company knowledge", () => {
  it("searches titles shared with the integration and returns compact matches", async () => {
    const search = vi.fn().mockResolvedValue({
      results: [
        {
          object: "page",
          id: "goals-page",
          url: "https://notion.so/goals-page",
          last_edited_time: "2026-08-10T12:00:00.000Z",
          properties: {
            title: {
              type: "title",
              title: [{ plain_text: "Company Goals - 2026" }],
            },
          },
        },
        {
          object: "data_source",
          id: "updates-source",
          url: "https://notion.so/updates-source",
          last_edited_time: "2026-08-09T12:00:00.000Z",
          title: [{ plain_text: "Weekly Product Updates" }],
        },
      ],
      has_more: false,
    });
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      knowledgeEnabled: true,
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: {},
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, { client: { search } });

    await expect(service.searchKnowledge("goals", 5)).resolves.toEqual({
      results: [
        {
          id: "goals-page",
          type: "page",
          title: "Company Goals - 2026",
          url: "https://notion.so/goals-page",
          lastEditedTime: "2026-08-10T12:00:00.000Z",
        },
        {
          id: "updates-source",
          type: "data_source",
          title: "Weekly Product Updates",
          url: "https://notion.so/updates-source",
          lastEditedTime: "2026-08-09T12:00:00.000Z",
        },
      ],
      hasMore: false,
    });
    expect(search).toHaveBeenCalledWith({
      query: "goals",
      page_size: 5,
      sort: { property: "relevance" },
      filter: { in_trash: false },
    });
  });

  it("reads only bounded page Markdown", async () => {
    const retrieveMarkdown = vi.fn().mockResolvedValue({
      object: "page_markdown",
      id: "goals-page",
      markdown: "Company goals",
      truncated: false,
      unknown_block_ids: [],
    });
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      knowledgeEnabled: true,
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: {},
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { pages: { retrieveMarkdown } },
    });

    await expect(
      service.readKnowledgeResource("goals-page", "page"),
    ).resolves.toEqual({
      id: "goals-page",
      type: "page",
      markdown: "Company goals",
      truncated: false,
    });
  });

  it("returns compact recent rows for a matched data source", async () => {
    const query = vi.fn().mockResolvedValue({
      results: [
        {
          object: "page",
          id: "update-row",
          url: "https://notion.so/update-row",
          last_edited_time: "2026-08-10T12:00:00.000Z",
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Week 32" }],
            },
            Status: { type: "status", status: { name: "Published" } },
          },
        },
      ],
      has_more: false,
    });
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      knowledgeEnabled: true,
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: {},
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { dataSources: { query } },
    });

    await expect(
      service.readKnowledgeResource("updates-source", "data_source"),
    ).resolves.toEqual({
      id: "updates-source",
      type: "data_source",
      rows: [
        {
          id: "update-row",
          url: "https://notion.so/update-row",
          lastEditedTime: "2026-08-10T12:00:00.000Z",
          properties: { Name: "Week 32", Status: "Published" },
        },
      ],
      hasMore: false,
    });
    expect(query).toHaveBeenCalledWith({
      data_source_id: "updates-source",
      page_size: 5,
      result_type: "page",
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });
  });
});

describe("Notion task updates and digests", () => {
  it("updates task properties and appends task-page content", async () => {
    const update = vi.fn().mockResolvedValue({
      object: "page",
      id: "task-page",
      url: "https://notion.so/task-page",
    });
    const updateMarkdown = vi.fn().mockResolvedValue({
      object: "page_markdown",
      id: "task-page",
      markdown: "Updated",
      truncated: false,
      unknown_block_ids: [],
    });
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: { tanvi: "tanvi-user-id" },
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { pages: { update, updateMarkdown } },
    });

    await expect(
      service.updateTask({
        pageId: "task-page",
        title: "Feedbacks from Intern Applications",
        newTitle: "Review Intern Application Feedback",
        status: "In progress",
        dueAt: "2026-08-20",
        assignee: "Tanvi",
        priority: "High",
        taskTypes: ["Product", "Misc"],
        clearFields: [],
        pageContentMode: "append",
        pageContent: "## Update\n\nReview the shortlisted feedback.",
      }),
    ).resolves.toEqual({
      id: "task-page",
      url: "https://notion.so/task-page",
      title: "Review Intern Application Feedback",
      status: "In progress",
      dueAt: "2026-08-20",
      assignee: "Tanvi",
      priority: "High",
      taskTypes: ["Product", "Misc"],
      clearedFields: [],
      pageContentMode: "append",
    });
    expect(update).toHaveBeenCalledWith({
      page_id: "task-page",
      properties: {
        "Task name": {
          type: "title",
          title: [
            {
              type: "text",
              text: { content: "Review Intern Application Feedback" },
            },
          ],
        },
        Status: { type: "status", status: { name: "In progress" } },
        "Due date": { type: "date", date: { start: "2026-08-20" } },
        Assignee: { type: "people", people: [{ id: "tanvi-user-id" }] },
        Priority: { type: "select", select: { name: "High" } },
        "Task type": {
          type: "multi_select",
          multi_select: [{ name: "Product" }, { name: "Misc" }],
        },
      },
    });
    expect(updateMarkdown).toHaveBeenCalledWith({
      page_id: "task-page",
      type: "insert_content",
      insert_content: {
        content: "## Update\n\nReview the shortlisted feedback.",
        position: { type: "end" },
      },
    });
  });

  it("clears task properties and replaces page content without deleting children", async () => {
    const update = vi.fn().mockResolvedValue({ object: "page", id: "task-page" });
    const updateMarkdown = vi.fn().mockResolvedValue({
      object: "page_markdown",
      id: "task-page",
      markdown: "Replacement",
      truncated: false,
      unknown_block_ids: [],
    });
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: {},
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { pages: { update, updateMarkdown } },
    });

    await service.updateTask({
      pageId: "task-page",
      title: "Old task",
      newTitle: null,
      status: null,
      dueAt: null,
      assignee: null,
      priority: null,
      taskTypes: null,
      clearFields: ["due_date", "assignee", "priority", "task_type"],
      pageContentMode: "replace",
      pageContent: "## Fresh brief",
    });

    expect(update).toHaveBeenCalledWith({
      page_id: "task-page",
      properties: {
        "Due date": { type: "date", date: null },
        Assignee: { type: "people", people: [] },
        Priority: { type: "select", select: null },
        "Task type": { type: "multi_select", multi_select: [] },
      },
    });
    expect(updateMarkdown).toHaveBeenCalledWith({
      page_id: "task-page",
      type: "replace_content",
      replace_content: {
        new_str: "## Fresh brief",
        allow_deleting_content: false,
      },
    });
  });

  it.each([
    ["Not started", true],
    ["In progress", true],
    [null, true],
    ["Completed", false],
    ["Done", false],
    ["Cancelled", false],
  ])("classifies task status %s as incomplete=%s", (status, expected) => {
    expect(isIncompleteTaskStatus(status)).toBe(expected);
  });

  it("paginates the tracker and returns every incomplete task", async () => {
    const taskPage = (id: string, title: string, status: string) => ({
      object: "page",
      id,
      url: `https://notion.so/${id}`,
      properties: {
        "Task name": { type: "title", title: [{ plain_text: title }] },
        Status: { type: "status", status: { name: status } },
        "Due date": { type: "date", date: null },
        Assignee: { type: "people", people: [] },
        Priority: { type: "select", select: null },
        "Task type": { type: "multi_select", multi_select: [] },
      },
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: [
          taskPage("open-1", "Open task", "Not started"),
          taskPage("done-1", "Finished task", "Completed"),
        ],
        has_more: true,
        next_cursor: "next-page",
      })
      .mockResolvedValueOnce({
        results: [taskPage("open-2", "Ongoing task", "In progress")],
        has_more: false,
        next_cursor: null,
      });
    const service = new NotionTaskService({
      apiKey: "test-key",
      dataSourceId: "tasks-source",
      properties,
      defaultStatus: "Not started",
      defaultAssigneeId: undefined,
      assigneeMap: {},
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { dataSources: { query } },
    });

    await expect(service.listIncompleteTasks()).resolves.toMatchObject({
      tasks: [
        { id: "open-1", title: "Open task" },
        { id: "open-2", title: "Ongoing task" },
      ],
      hasMore: false,
    });
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ start_cursor: "next-page" }),
    );
  });
});
