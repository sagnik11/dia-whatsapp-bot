import { Client, type PageObjectResponse } from "@notionhq/client";
import type { Logger } from "./logger.js";
import type {
  BrainDumpResult,
  TaskInput,
  TaskListResult,
  TaskQuery,
  TaskResult,
  TaskSource,
  TaskSummary,
} from "./types.js";

export interface NotionPropertyNames {
  title: string;
  status: string;
  dueDate: string;
  assignee: string;
  priority: string;
  taskType: string;
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
  properties: NotionPropertyNames;
  defaultStatus: string;
  defaultAssigneeId: string | undefined;
  assigneeMap: Readonly<Record<string, string>>;
  logger: Logger;
}

const MAX_BRAIN_DUMP_CHARACTERS = 12_000;

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
}
