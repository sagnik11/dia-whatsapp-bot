import { AUTTER_CONTEXT, CAPTAIN_PATCH_PERSONA } from "./captain-patch.js";
import type { LanguageModel } from "./llm.js";
import type { Logger } from "./logger.js";
import type { TaskListResult } from "./task-store.js";
import type { ReminderRecord } from "./types.js";

interface FounderBriefOptions {
  llm: LanguageModel;
  timezone: string;
  logger: Logger;
}

/** Opt-in daily brief built only from Patch's own D1 task list and reminders. */
export class FounderBriefGenerator {
  public constructor(private readonly options: FounderBriefOptions) {}

  public async generate(
    tasks: TaskListResult,
    reminders: readonly ReminderRecord[],
  ): Promise<string> {
    const response = await this.options.llm.complete({
      system: [
        CAPTAIN_PATCH_PERSONA,
        AUTTER_CONTEXT,
        "You are acting as Autter's chief of staff. Create one concise daily brief for Sagnik and Tanvi in a WhatsApp group.",
        "Prioritize overdue and near-due work, then blocked work, unowned work, and useful reminders. Suggest at most three focus items.",
        "Do not invent facts. Use only the supplied task and reminder data, and refer to tasks by their #id.",
        "Use a short heading, Today, Risks/blockers, and Suggested focus. Maximum 2,500 characters.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            currentTime: new Date().toISOString(),
            timezone: this.options.timezone,
            tasks: tasks.tasks.slice(0, 100),
            moreTasksNotShown: tasks.hasMore,
            reminders: reminders.slice(0, 50),
          }),
        },
      ],
      metadata: { feature: "founder_brief" },
    });
    const output = response.text.trim().slice(0, 3_500);
    if (!output) throw new Error("The model returned an empty founder brief");
    this.options.logger.info(
      { taskCount: tasks.tasks.length, reminderCount: reminders.length },
      "Generated founder brief",
    );
    return output;
  }
}
