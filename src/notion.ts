import {
  Client,
  type PageObjectResponse,
  type SearchResponse,
} from "@notionhq/client";
import type { Logger } from "./logger.js";
import type {
  BrainDumpAppendInput,
  BrainDumpAppendResult,
  BrainDumpResult,
  KnowledgeResourceResult,
  KnowledgeSearchResponse,
  TaskInput,
  TaskListResult,
  TaskQuery,
  TaskResult,
  TaskSource,
  TaskSummary,
  TaskUpdateInput,
  TaskUpdateResult,
} from "./types.js";

export interface NotionPropertyNames {
  title: string;
  status: string;
  dueDate: string;
  assignee: string;
  priority: string;
  taskType: string;
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&");
}

export function brainDumpAppendMarkdown(
  input: BrainDumpAppendInput,
  source: TaskSource,
): string {
  const heading = input.heading?.trim();
  return [
    "",
    `## ${heading || "WhatsApp note"}`,
    "",
    input.content.trim(),
    "",
    `_Added from WhatsApp · ${escapeMarkdownInline(source.groupName)} · ${escapeMarkdownInline(source.requestedBy)}_`,
  ].join("\n");
}

type TaskPropertyFilter =
  | { property: string; title: { contains: string } }
  | { property: string; status: { equals: string } }
  | { property: string; date: { on_or_after: string } }
  | { property: string; date: { on_or_before: string } };

interface NotionTaskServiceOptions {
  apiKey: string;
  dataSourceId: string;
  brainDumpPageId?: string;
  knowledgeEnabled?: boolean;
  properties: NotionPropertyNames;
  defaultStatus: string;
  defaultAssigneeId: string | undefined;
  assigneeMap: Readonly<Record<string, string>>;
  logger: Logger;
}

const MAX_BRAIN_DUMP_CHARACTERS = 12_000;
const MAX_KNOWLEDGE_PAGE_CHARACTERS = 12_000;

type NotionSearchItem = SearchResponse["results"][number];
type NotionPageProperty = PageObjectResponse["properties"][string];

function plainText(
  items: ReadonlyArray<{ plain_text: string }>,
  maxCharacters = 400,
): string {
  return items.map((item) => item.plain_text).join("").trim().slice(0, maxCharacters);
}

function searchItemTitle(item: NotionSearchItem): string {
  if (item.object === "page" && "properties" in item) {
    const title = Object.values(item.properties).find(
      (property) => property.type === "title",
    );
    return title?.type === "title" ? plainText(title.title) : "";
  }

  if (item.object === "data_source" && "title" in item) {
    return plainText(item.title);
  }

  return "";
}

function summarizePageProperty(property: NotionPageProperty): unknown {
  switch (property.type) {
    case "title":
      return plainText(property.title);
    case "rich_text":
      return plainText(property.rich_text);
    case "number":
      return property.number;
    case "select":
      return property.select?.name ?? null;
    case "multi_select":
      return property.multi_select.slice(0, 20).map((option) => option.name);
    case "status":
      return property.status?.name ?? null;
    case "date":
      return property.date;
    case "checkbox":
      return property.checkbox;
    case "url":
      return property.url;
    case "email":
      return property.email;
    case "phone_number":
      return property.phone_number;
    case "people":
      return property.people.slice(0, 10).map((person) =>
        "name" in person && person.name ? person.name : person.id,
      );
    case "created_time":
      return property.created_time;
    case "last_edited_time":
      return property.last_edited_time;
    case "created_by":
      return "name" in property.created_by && property.created_by.name
        ? property.created_by.name
        : property.created_by.id;
    case "last_edited_by":
      return "name" in property.last_edited_by && property.last_edited_by.name
        ? property.last_edited_by.name
        : property.last_edited_by.id;
    case "relation":
      return property.relation.slice(0, 10).map((relation) => relation.id);
    case "unique_id":
      return `${property.unique_id.prefix ?? ""}${property.unique_id.number}`;
    default:
      return undefined;
  }
}

function summarizePageProperties(
  properties: PageObjectResponse["properties"],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(properties).slice(0, 20).flatMap(([name, property]) => {
      const value = summarizePageProperty(property);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export function boundBrainDumpMarkdown(markdown: string): {
  markdown: string;
  truncated: boolean;
} {
  if (markdown.length <= MAX_BRAIN_DUMP_CHARACTERS) {
    return { markdown, truncated: false };
  }

  return {
    markdown: `${markdown.slice(0, MAX_BRAIN_DUMP_CHARACTERS)}\n\n[Content truncated by Captain Patch]`,
    truncated: true,
  };
}

export function resolveAssigneeId(
  assignee: string | null,
  defaultAssigneeId: string | undefined,
  assigneeMap: Readonly<Record<string, string>>,
): string | undefined {
  if (!assignee || ["me", "myself"].includes(assignee.trim().toLowerCase())) {
    return defaultAssigneeId;
  }
  return assigneeMap[assignee.trim().toLowerCase()];
}

export function isIncompleteTaskStatus(status: string | null): boolean {
  if (!status) return true;
  return ![
    "complete",
    "completed",
    "done",
    "cancelled",
    "canceled",
    "archived",
  ].includes(status.trim().toLowerCase());
}

function pageMarkdown(input: TaskInput, source: TaskSource): string {
  const lines = [
    "## WhatsApp source",
    `- **Group:** ${source.groupName}`,
    `- **Requested by:** ${source.requestedBy}`,
    `- **Message ID:** \`${source.messageId}\``,
  ];

  if (input.assignee) {
    lines.push(`- **Requested assignee:** ${input.assignee}`);
  }
  if (input.notes) {
    lines.push("", "## Notes", input.notes);
  }
  return lines.join("\n");
}

export function buildTaskQueryFilter(
  input: TaskQuery,
  properties: NotionPropertyNames,
): TaskPropertyFilter | { and: TaskPropertyFilter[] } | undefined {
  const filters: TaskPropertyFilter[] = [];
  if (input.titleContains) {
    filters.push({
      property: properties.title,
      title: { contains: input.titleContains },
    });
  }
  if (input.status) {
    filters.push({
      property: properties.status,
      status: { equals: input.status },
    });
  }
  if (input.dueFrom) {
    filters.push({
      property: properties.dueDate,
      date: { on_or_after: input.dueFrom },
    });
  }
  if (input.dueTo) {
    filters.push({
      property: properties.dueDate,
      date: { on_or_before: input.dueTo },
    });
  }

  if (filters.length === 0) return undefined;
  if (filters.length === 1) return filters[0];
  return { and: filters };
}

export function taskSummaryFromPage(
  page: PageObjectResponse,
  properties: NotionPropertyNames,
): TaskSummary {
  const titleProperty = page.properties[properties.title];
  const statusProperty = page.properties[properties.status];
  const dueDateProperty = page.properties[properties.dueDate];
  const assigneeProperty = page.properties[properties.assignee];
  const priorityProperty = page.properties[properties.priority];
  const taskTypeProperty = page.properties[properties.taskType];

  const title =
    titleProperty?.type === "title"
      ? titleProperty.title.map((item) => item.plain_text).join("").trim()
      : "";
  const assignees =
    assigneeProperty?.type === "people"
      ? assigneeProperty.people
          .map((person) => ("name" in person ? person.name : null))
          .filter((name): name is string => Boolean(name))
      : [];

  return {
    id: page.id,
    url: page.url,
    title: title || "Untitled task",
    status:
      statusProperty?.type === "status"
        ? (statusProperty.status?.name ?? null)
        : null,
    dueAt:
      dueDateProperty?.type === "date"
        ? (dueDateProperty.date?.start ?? null)
        : null,
    assignees,
    priority:
      priorityProperty?.type === "select"
        ? (priorityProperty.select?.name ?? null)
        : null,
    taskTypes:
      taskTypeProperty?.type === "multi_select"
        ? taskTypeProperty.multi_select.map((option) => option.name)
        : [],
  };
}

export class NotionTaskService {
  private readonly client: Client;

  public constructor(private readonly options: NotionTaskServiceOptions) {
    this.client = new Client({ auth: options.apiKey });
  }

  public get canReadBrainDump(): boolean {
    return Boolean(this.options.brainDumpPageId);
  }

  public get canReadKnowledge(): boolean {
    return Boolean(this.options.knowledgeEnabled);
  }

  public async searchKnowledge(
    query: string,
    limit: number,
  ): Promise<KnowledgeSearchResponse> {
    if (!this.canReadKnowledge) {
      throw new Error("NOTION_KNOWLEDGE_ENABLED is not enabled");
    }

    const response = await this.client.search({
      query,
      page_size: limit,
      sort: { property: "relevance" },
      filter: { in_trash: false },
    });
    const results = response.results.flatMap((item) => {
      const title = searchItemTitle(item);
      if (!title) return [];
      return [
        {
          id: item.id,
          type: item.object,
          title,
          url: "url" in item && typeof item.url === "string" ? item.url : null,
          lastEditedTime:
            "last_edited_time" in item &&
            typeof item.last_edited_time === "string"
              ? item.last_edited_time
              : null,
        },
      ];
    });

    this.options.logger.info(
      { resultCount: results.length, hasMore: response.has_more },
      "Searched Notion knowledge",
    );
    return { results, hasMore: response.has_more };
  }

  public async readKnowledgeResource(
    id: string,
    type: "page" | "data_source",
  ): Promise<KnowledgeResourceResult> {
    if (!this.canReadKnowledge) {
      throw new Error("NOTION_KNOWLEDGE_ENABLED is not enabled");
    }

    if (type === "page") {
      const response = await this.client.pages.retrieveMarkdown({
        page_id: id,
        include_transcript: false,
      });
      const bounded =
        response.markdown.length <= MAX_KNOWLEDGE_PAGE_CHARACTERS
          ? { markdown: response.markdown, truncated: false }
          : {
              markdown: `${response.markdown.slice(0, MAX_KNOWLEDGE_PAGE_CHARACTERS)}\n\n[Notion page truncated by Captain Patch]`,
              truncated: true,
            };
      const truncated = response.truncated || bounded.truncated;

      this.options.logger.info(
        { notionPageId: id, characters: bounded.markdown.length, truncated },
        "Read Notion knowledge page",
      );
      return { id, type, markdown: bounded.markdown, truncated };
    }

    const response = await this.client.dataSources.query({
      data_source_id: id,
      page_size: 5,
      result_type: "page",
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });
    const rows = response.results
      .filter(
        (result): result is PageObjectResponse =>
          result.object === "page" && "properties" in result,
      )
      .map((page) => ({
        id: page.id,
        url: page.url,
        lastEditedTime: page.last_edited_time,
        properties: summarizePageProperties(page.properties),
      }));

    this.options.logger.info(
      { notionDataSourceId: id, rowCount: rows.length, hasMore: response.has_more },
      "Read Notion knowledge data source",
    );
    return { id, type, rows, hasMore: response.has_more };
  }

  public async readBrainDump(): Promise<BrainDumpResult> {
    const pageId = this.options.brainDumpPageId;
    if (!pageId) {
      throw new Error("NOTION_BRAIN_DUMP_PAGE_ID is not configured");
    }

    const response = await this.client.pages.retrieveMarkdown({
      page_id: pageId,
      include_transcript: false,
    });
    const bounded = boundBrainDumpMarkdown(response.markdown);
    const truncated = response.truncated || bounded.truncated;

    this.options.logger.info(
      { notionPageId: pageId, characters: bounded.markdown.length, truncated },
      "Read Notion Brain Dump",
    );

    return { pageId, markdown: bounded.markdown, truncated };
  }

  public async appendBrainDump(
    input: BrainDumpAppendInput,
    source: TaskSource,
  ): Promise<BrainDumpAppendResult> {
    const pageId = this.options.brainDumpPageId;
    if (!pageId) {
      throw new Error("NOTION_BRAIN_DUMP_PAGE_ID is not configured");
    }

    const markdown = brainDumpAppendMarkdown(input, source);
    await this.client.pages.updateMarkdown({
      page_id: pageId,
      type: "insert_content",
      insert_content: {
        content: markdown,
        position: { type: "end" },
      },
    });

    this.options.logger.info(
      {
        notionPageId: pageId,
        charactersAdded: markdown.length,
        hasHeading: Boolean(input.heading),
      },
      "Appended to Notion Brain Dump",
    );

    return {
      pageId,
      heading: input.heading,
      charactersAdded: markdown.length,
    };
  }

  public async createTask(input: TaskInput, source: TaskSource): Promise<TaskResult> {
    const p = this.options.properties;
    const assigneeId = resolveAssigneeId(
      input.assignee,
      this.options.defaultAssigneeId,
      this.options.assigneeMap,
    );
    const response = await this.client.pages.create({
      parent: {
        type: "data_source_id",
        data_source_id: this.options.dataSourceId,
      },
      properties: {
        [p.title]: {
          type: "title",
          title: [{ type: "text", text: { content: input.title } }],
        },
        [p.status]: {
          type: "status",
          status: { name: this.options.defaultStatus },
        },
        [p.dueDate]: {
          type: "date",
          date: input.dueAt ? { start: input.dueAt } : null,
        },
        ...(assigneeId
          ? {
              [p.assignee]: {
                type: "people" as const,
                people: [{ id: assigneeId }],
              },
            }
          : {}),
        ...(input.priority
          ? {
              [p.priority]: {
                type: "select" as const,
                select: { name: input.priority },
              },
            }
          : {}),
        ...(input.taskType
          ? {
              [p.taskType]: {
                type: "multi_select" as const,
                multi_select: [{ name: input.taskType }],
              },
            }
          : {}),
      },
      markdown: pageMarkdown(input, source),
    });

    this.options.logger.info(
      { notionPageId: response.id, taskTitle: input.title },
      "Created Notion task",
    );

    return {
      id: response.id,
      url: "url" in response && typeof response.url === "string" ? response.url : null,
      title: input.title,
    };
  }

  public async updateTask(input: TaskUpdateInput): Promise<TaskUpdateResult> {
    if (!input.status && !input.assignee) {
      throw new Error("A task update must include a status or assignee");
    }

    const p = this.options.properties;
    const assigneeId = input.assignee
      ? resolveAssigneeId(
          input.assignee,
          this.options.defaultAssigneeId,
          this.options.assigneeMap,
        )
      : undefined;
    if (input.assignee && !assigneeId) {
      throw new Error(
        `No Notion user ID is configured for assignee ${input.assignee}`,
      );
    }

    const response = await this.client.pages.update({
      page_id: input.pageId,
      properties: {
        ...(input.status
          ? {
              [p.status]: {
                type: "status" as const,
                status: { name: input.status },
              },
            }
          : {}),
        ...(assigneeId
          ? {
              [p.assignee]: {
                type: "people" as const,
                people: [{ id: assigneeId }],
              },
            }
          : {}),
      },
    });

    this.options.logger.info(
      {
        notionPageId: input.pageId,
        taskTitle: input.title,
        status: input.status,
        assignee: input.assignee,
      },
      "Updated Notion task",
    );
    return {
      id: input.pageId,
      url: "url" in response && typeof response.url === "string" ? response.url : null,
      title: input.title,
      status: input.status,
      assignee: input.assignee,
    };
  }

  public async listTasks(input: TaskQuery): Promise<TaskListResult> {
    const p = this.options.properties;
    const filter = buildTaskQueryFilter(input, p);
    const response = await this.client.dataSources.query({
      data_source_id: this.options.dataSourceId,
      page_size: input.limit,
      result_type: "page",
      filter_properties: [
        p.title,
        p.status,
        p.dueDate,
        p.assignee,
        p.priority,
        p.taskType,
      ],
      ...(filter ? { filter } : {}),
      sorts: [{ property: p.dueDate, direction: "ascending" }],
    });
    const tasks = response.results
      .filter(
        (result): result is PageObjectResponse =>
          result.object === "page" && "properties" in result,
      )
      .map((page) => taskSummaryFromPage(page, p));

    this.options.logger.info(
      {
        count: tasks.length,
        dueFrom: input.dueFrom,
        dueTo: input.dueTo,
        hasMore: response.has_more,
        status: input.status,
        titleContains: input.titleContains,
      },
      "Read Notion tasks",
    );

    return { tasks, hasMore: response.has_more };
  }

  public async listIncompleteTasks(): Promise<TaskListResult> {
    const p = this.options.properties;
    const tasks: TaskSummary[] = [];
    let cursor: string | undefined;
    let rowCount = 0;
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.options.dataSourceId,
        page_size: 100,
        result_type: "page",
        filter_properties: [
          p.title,
          p.status,
          p.dueDate,
          p.assignee,
          p.priority,
          p.taskType,
        ],
        sorts: [{ property: p.dueDate, direction: "ascending" }],
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      const pageTasks = response.results
        .filter(
          (result): result is PageObjectResponse =>
            result.object === "page" && "properties" in result,
        )
        .map((page) => taskSummaryFromPage(page, p));
      rowCount += pageTasks.length;
      tasks.push(...pageTasks.filter((task) => isIncompleteTaskStatus(task.status)));
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);

    this.options.logger.info(
      { count: tasks.length, rowCount },
      "Read incomplete Notion tasks for digest",
    );
    return { tasks, hasMore: false };
  }
}
