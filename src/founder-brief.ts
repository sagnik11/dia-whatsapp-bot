import type OpenAI from "openai";
import { createAzureOpenAIClient } from "./azure-openai.js";
import { AUTTER_CONTEXT, CAPTAIN_PATCH_PERSONA } from "./captain-patch.js";
import type { Logger } from "./logger.js";
import type { ReminderRecord, TaskListResult } from "./types.js";

interface FounderBriefOptions {
  azureApiKey: string;
  azureBaseUrl: string;
  deployment: string;
  timezone: string;
  logger: Logger;
}

export class FounderBriefGenerator {
  private readonly client: OpenAI;

  public constructor(private readonly options: FounderBriefOptions) {
    this.client = createAzureOpenAIClient({
      apiKey: options.azureApiKey,
      baseUrl: options.azureBaseUrl,
    });
  }

  public async generate(
    tasks: TaskListResult,
    reminders: readonly ReminderRecord[],
  ): Promise<string> {
    const response = await this.client.responses.create({
      model: this.options.deployment,
      instructions: [
        CAPTAIN_PATCH_PERSONA,
        AUTTER_CONTEXT,
        "Create a concise daily founder brief for Sagnik and Tanvi in a WhatsApp group.",
        "Prioritize overdue and near-due work, then blockers, unassigned work, and useful reminders.",
        "Do not invent facts. Use only the supplied task and reminder data.",
        "Use a short heading, Today, Risks/blockers, and Suggested focus. Maximum 2,500 characters.",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: JSON.stringify({
            currentTime: new Date().toISOString(),
            timezone: this.options.timezone,
            tasks: tasks.tasks.slice(0, 150),
            reminders: reminders.slice(0, 50),
          }),
        },
      ],
      store: false,
    });
    const output = response.output_text.trim().slice(0, 3_500);
    if (!output) throw new Error("Azure OpenAI returned an empty founder brief");
    this.options.logger.info(
      { taskCount: tasks.tasks.length, reminderCount: reminders.length },
      "Generated founder brief",
    );
    return output;
  }
}
