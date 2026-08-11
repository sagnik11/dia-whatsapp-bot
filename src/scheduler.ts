import type { Logger } from "./logger.js";
import type { NotionTaskService } from "./notion.js";
import type { ReminderStore } from "./reminder-store.js";
import type { ReminderRecord, TaskListResult, TaskSummary } from "./types.js";

type SendMessage = (groupId: string, message: string) => Promise<void>;

interface SchedulerOptions {
  reminders: ReminderStore;
  notion: NotionTaskService;
  digestGroupIds: ReadonlySet<string>;
  digestIntervalHours: number;
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

function zonedParts(value: Date, timezone: string): Record<string, number> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function localTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timezone);
    const represented = Date.UTC(
      actual.year ?? year,
      (actual.month ?? month) - 1,
      actual.day ?? day,
      actual.hour ?? hour,
      actual.minute ?? minute,
      actual.second ?? 0,
    );
    candidate += desired - represented;
  }
  return candidate;
}

export function nextDailyRunAt(
  nowMs: number,
  time: string,
  timezone: string,
): number {
  const [hourText, minuteText] = time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const nowParts = zonedParts(new Date(nowMs), timezone);
  const year = nowParts.year ?? 1970;
  const month = nowParts.month ?? 1;
  const day = nowParts.day ?? 1;
  let candidate = localTimeToUtc(year, month, day, hour, minute, timezone);
  if (candidate <= nowMs) {
    const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
    candidate = localTimeToUtc(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      hour,
      minute,
      timezone,
    );
  }
  return candidate;
}

function formatDateTime(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

function formatDueAt(value: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(`${value}T00:00:00Z`));
  }
  return formatDateTime(value, timezone);
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

function taskDigestLine(task: TaskSummary, timezone: string): string {
  const details = [
    task.status ?? "No status",
    task.dueAt ? `due ${formatDueAt(task.dueAt, timezone)}` : "no due date",
    task.assignees.length > 0 ? task.assignees.join(", ") : "unassigned",
  ];
  return `• ${task.title} — ${details.join(" · ")}`;
}

export function formatTaskDigestMessages(
  result: TaskListResult,
  timezone: string,
): string[] {
  if (result.tasks.length === 0) {
    return ["📋 Scheduled task watch: no incomplete tasks. Suspiciously competent."];
  }

  const header = `📋 Scheduled task watch — ${result.tasks.length} incomplete task${result.tasks.length === 1 ? "" : "s"}`;
  const messages: string[] = [];
  let current = header;
  for (const task of result.tasks) {
    const line = taskDigestLine(task, timezone).slice(0, 3_200);
    if (`${current}\n${line}`.length > 3_500 && current !== header) {
      messages.push(current);
      current = `📋 Task watch (continued)\n${line}`;
    } else {
      current = `${current}\n${line}`;
    }
  }
  messages.push(current);
  return messages;
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

      await this.sendTaskDigests(nowMs, send);
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

    const tasks = await this.options.notion.listIncompleteTasks();
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

  private async sendTaskDigests(nowMs: number, send: SendMessage): Promise<void> {
    if (
      this.options.digestIntervalHours <= 0 ||
      this.options.digestGroupIds.size === 0
    ) {
      return;
    }

    const dueGroups = [...this.options.digestGroupIds].filter((groupId) => {
      const key = `task_digest:${groupId}`;
      return this.options.reminders.getOrCreateNextRun(key, nowMs) <= nowMs;
    });
    if (dueGroups.length === 0) return;

    const tasks = await this.options.notion.listIncompleteTasks();
    const outputs = formatTaskDigestMessages(tasks, this.options.timezone);
    const intervalMs = this.options.digestIntervalHours * 60 * 60 * 1_000;
    for (const groupId of dueGroups) {
      try {
        for (const output of outputs) await send(groupId, output);
        this.options.reminders.setNextRun(
          `task_digest:${groupId}`,
          nowMs + intervalMs,
        );
        this.options.logger.info(
          { groupId, taskCount: tasks.tasks.length, outputs },
          "Sent incomplete task digest",
        );
      } catch (error) {
        this.options.logger.error(
          { error, groupId },
          "Failed to send incomplete task digest; it will be retried",
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
