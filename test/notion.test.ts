import { describe, expect, it, vi } from "vitest";
import {
  NotionWorkspaceService,
  boundBrainDumpMarkdown,
  brainDumpAppendMarkdown,
  splitMarkdownForNotion,
} from "../src/notion.js";

describe("Notion Brain Dump reads", () => {
  it("retrieves only the configured page as markdown", async () => {
    const retrieveMarkdown = vi.fn().mockResolvedValue({
      object: "page_markdown",
      id: "brain-page",
      markdown: "# Brain Dump\n\nAn onboarding idea",
      truncated: false,
      unknown_block_ids: [],
    });
    const service = new NotionWorkspaceService({
      apiKey: "test-key",
      brainDumpPageId: "brain-page",
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
    const service = new NotionWorkspaceService({
      apiKey: "test-key",
      brainDumpPageId: "brain-page",
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

  it("splits very large Markdown without dropping or reordering content", () => {
    const markdown = [
      "## Founder notes\n\n",
      "a".repeat(105_000),
      "\n\n## Research\n\n",
      "b".repeat(105_000),
      "🚀".repeat(10_000),
    ].join("");

    const chunks = splitMarkdownForNotion(markdown);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 100_000)).toBe(true);
    expect(chunks.join("")).toBe(markdown);
  });

  it("appends every large-content chunk to Notion in order", async () => {
    const updateMarkdown = vi.fn().mockResolvedValue({
      object: "page_markdown",
      id: "brain-page",
      markdown: "",
      truncated: false,
      unknown_block_ids: [],
    });
    const service = new NotionWorkspaceService({
      apiKey: "test-key",
      brainDumpPageId: "brain-page",
      logger: { info: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { pages: { updateMarkdown } },
    });
    const content = `Start\n\n${"large paragraph ".repeat(16_000)}\n\nEnd`;

    const result = await service.appendBrainDump(
      { heading: "Large founder note", content },
      {
        groupName: "Autter founders",
        requestedBy: "Sagnik",
        messageId: "large-message",
      },
    );
    const written = updateMarkdown.mock.calls
      .map((call) => call[0].insert_content.content as string)
      .join("");

    expect(updateMarkdown.mock.calls.length).toBeGreaterThan(1);
    expect(written).toContain(content);
    expect(written.length).toBe(result.charactersAdded);
  });
});

describe("Notion company knowledge", () => {
  it("discovers and reads live scripts across multiple data sources", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        results: [
          {
            object: "page",
            id: "episode-1",
            url: "https://notion.so/episode-1",
            last_edited_time: "2026-08-20T10:00:00.000Z",
            properties: {
              "Doc name": {
                type: "title",
                title: [{ plain_text: "Dekhte Hai Ep 1" }],
              },
            },
          },
          {
            object: "page",
            id: "topics",
            url: "https://notion.so/topics",
            last_edited_time: "2026-08-21T10:00:00.000Z",
            properties: {
              "Doc name": {
                type: "title",
                title: [{ plain_text: "Dekhte Hai Topics" }],
              },
            },
          },
        ],
        has_more: false,
      })
      .mockResolvedValueOnce({
        results: [
          {
            object: "page",
            id: "episode-5",
            url: "https://notion.so/episode-5",
            last_edited_time: "2026-08-25T10:00:00.000Z",
            properties: {
              "Post name": {
                type: "title",
                title: [{ plain_text: "Dekhte Hai Ep5" }],
              },
            },
          },
        ],
        has_more: false,
      });
    const retrieveMarkdown = vi.fn(async ({ page_id }: { page_id: string }) => ({
      object: "page_markdown",
      id: page_id,
      markdown: `Live content for ${page_id}`,
      truncated: false,
      unknown_block_ids: [],
    }));
    const service = new NotionWorkspaceService({
      apiKey: "test-key",
      scriptSources: [
        { dataSourceId: "document-hub", titleProperty: "Doc name" },
        { dataSourceId: "content-planner", titleProperty: "Post name" },
      ],
      scriptSeriesName: "Dekhte Hai",
      logger: { info: vi.fn(), warn: vi.fn() } as never,
    });
    Object.assign(service as unknown as { client: unknown }, {
      client: { dataSources: { query }, pages: { retrieveMarkdown } },
    });

    await expect(service.readScriptLibrary()).resolves.toEqual({
      seriesName: "Dekhte Hai",
      scripts: [
        expect.objectContaining({
          episode: 1,
          id: "episode-1",
          markdown: "Live content for episode-1",
        }),
        expect.objectContaining({
          episode: 5,
          id: "episode-5",
          markdown: "Live content for episode-5",
        }),
      ],
    });
    expect(retrieveMarkdown).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data_source_id: "document-hub",
        filter: { property: "Doc name", title: { contains: "Dekhte Hai" } },
      }),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data_source_id: "content-planner",
        filter: { property: "Post name", title: { contains: "Dekhte Hai" } },
      }),
    );
  });

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
    const service = new NotionWorkspaceService({
      apiKey: "test-key",
      knowledgeEnabled: true,
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
    const service = new NotionWorkspaceService({
      apiKey: "test-key",
      knowledgeEnabled: true,
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
    const service = new NotionWorkspaceService({
      apiKey: "test-key",
      knowledgeEnabled: true,
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

