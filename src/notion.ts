import { Client } from "@notionhq/client";
import type { Logger } from "./logger.js";
import type { TaskInput, TaskResult, TaskSource } from "./types.js";

interface NotionPropertyNames {
  title: string;
  status: string;
  dueDate: string;
  assignee: string;
  requestedBy: string;
  sourceGroup: string;
  sourceMessage: string;
  notes: string;
}

interface NotionTaskServiceOptions {
  apiKey: string;
  dataSourceId: string;
  properties: NotionPropertyNames;
  defaultStatus: string;
  logger: Logger;
}

const richText = (content: string) => ({
  type: "rich_text" as const,
  rich_text: [{ type: "text" as const, text: { content } }],
});

export class NotionTaskService {
  private readonly client: Client;

  public constructor(private readonly options: NotionTaskServiceOptions) {
    this.client = new Client({ auth: options.apiKey });
  }

  public async createTask(input: TaskInput, source: TaskSource): Promise<TaskResult> {
    const p = this.options.properties;
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
        [p.assignee]: richText(input.assignee ?? ""),
        [p.requestedBy]: richText(source.requestedBy),
        [p.sourceGroup]: richText(source.groupName),
        [p.sourceMessage]: richText(source.messageId),
        [p.notes]: richText(input.notes ?? ""),
      },
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
