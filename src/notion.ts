import { Client } from "@notionhq/client";
import type { Logger } from "./logger.js";
import type { TaskInput, TaskResult, TaskSource } from "./types.js";

interface NotionPropertyNames {
  title: string;
  status: string;
  dueDate: string;
  assignee: string;
  priority: string;
  taskType: string;
}

interface NotionTaskServiceOptions {
  apiKey: string;
  dataSourceId: string;
  properties: NotionPropertyNames;
  defaultStatus: string;
  defaultAssigneeId: string | undefined;
  assigneeMap: Readonly<Record<string, string>>;
  logger: Logger;
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

export class NotionTaskService {
  private readonly client: Client;

  public constructor(private readonly options: NotionTaskServiceOptions) {
    this.client = new Client({ auth: options.apiKey });
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
}
