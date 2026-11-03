import type { Logger } from "./logger.js";
import type { ReminderStore } from "./reminder-store.js";
import type { TaskListResult, TaskStore } from "./task-store.js";
import { nextDailyRunAt } from "./time.js";
import type { ReminderRecord } from "./types.js";

export { nextDailyRunAt } from "./time.js";

type SendMessage = (groupId: string, message: string) => Promise<void>;

/**
 * Patch only speaks unprompted for reminders a founder explicitly set, plus
 * the opt-in daily brief. There is no periodic task digest.
 */
interface SchedulerOptions {
  reminders: ReminderStore;
  tasks: Pick<TaskStore, "listOpen">;
  timezone: string;
  logger: Logger;
  pollIntervalMs?: number;
  founderBrief?: {
    time: string;
    groupIds: ReadonlySet<string>;
    generate: (
      tasks: TaskListResult,
      reminders: readonly ReminderRecord[],
    ) => Promise<string>;
  };
}

export function formatReminderDelivery(reminder: ReminderRecord): string {
  if (reminder.phase === "pre_due") {
    return `⏰ Heads-up for ${reminder.requestedBy}: ${reminder.message}\nDue in ${reminder.notifyBeforeMinutes} minutes.`;
  }
  if (reminder.phase === "repeat") {
    return `⏰ Still pending for ${reminder.requestedBy}: ${reminder.message}\nReminder #${reminder.id} will keep repeating until cancelled.`;
  }
  return `⏰ Due now for ${reminder.requestedBy}: ${reminder.message}`;
}

export class ProactiveScheduler {
  private timer: NodeJS.Timeout | undefined;
  private send: SendMessage | undefined;
  private running = false;
  private activeRun: Promise<void> | undefined;

  public constructor(private readonly options: SchedulerOptions) {}

  public start(send: SendMessage): void {
    if (this.timer) return;
    this.send = send;
    const pollIntervalMs = this.options.pollIntervalMs ?? 30_000;
    this.timer = setInterval(() => {
      this.triggerRun("Proactive scheduler tick failed");
    }, pollIntervalMs);
    this.timer.unref();
    this.triggerRun("Initial proactive scheduler tick failed");
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.send = undefined;
    await this.activeRun;
  }

  public async runOnce(
    nowMs = Date.now(),
    sendOverride?: SendMessage,
  ): Promise<void> {
    const send = sendOverride ?? this.send;
    if (this.running || !send) return;
    this.running = true;
    try {
      for (const reminder of this.options.reminders.due(nowMs)) {
        try {
          const output = formatReminderDelivery(reminder);
          await send(reminder.groupId, output);
          this.options.reminders.advanceAfterDelivery(reminder, nowMs);
          this.options.logger.info(
            {
              groupId: reminder.groupId,
              reminderId: reminder.id,
              phase: reminder.phase,
              output,
            },
            "Sent scheduled reminder",
          );
        } catch (error) {
          this.options.logger.error(
            { error, reminderId: reminder.id },
            "Failed to send scheduled reminder; it will be retried",
          );
        }
      }

      await this.sendFounderBriefs(nowMs, send);
    } finally {
      this.running = false;
    }
  }

  private async sendFounderBriefs(
    nowMs: number,
    send: SendMessage,
  ): Promise<void> {
    const brief = this.options.founderBrief;
    if (!brief || brief.groupIds.size === 0) return;
    const dueGroups = [...brief.groupIds].filter((groupId) => {
      const initialRun = nextDailyRunAt(nowMs, brief.time, this.options.timezone);
      return (
        this.options.reminders.getOrCreateNextRun(
          `founder_brief:${groupId}`,
          initialRun,
        ) <= nowMs
      );
    });
    if (dueGroups.length === 0) return;

    const tasks = await this.options.tasks.listOpen();
    for (const groupId of dueGroups) {
      try {
        const output = await brief.generate(
          tasks,
          this.options.reminders.listActive(groupId, 50),
        );
        await send(groupId, output);
        this.options.reminders.setNextRun(
          `founder_brief:${groupId}`,
          nextDailyRunAt(nowMs + 60_000, brief.time, this.options.timezone),
        );
        this.options.logger.info(
          { groupId, taskCount: tasks.tasks.length, output },
          "Sent daily founder brief",
        );
      } catch (error) {
        this.options.logger.error(
          { error, groupId },
          "Failed to send founder brief; it will be retried",
        );
      }
    }
  }

  private triggerRun(errorMessage: string): void {
    if (this.activeRun) return;
    const run = this.runOnce().catch((error: unknown) => {
      this.options.logger.error({ error }, errorMessage);
    });
    this.activeRun = run;
    void run.finally(() => {
      if (this.activeRun === run) this.activeRun = undefined;
    });
  }
}
