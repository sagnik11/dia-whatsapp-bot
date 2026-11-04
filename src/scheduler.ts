import type { ConversationStore } from "./conversation-store.js";
import type { FounderBriefInput } from "./founder-brief.js";
import type { Logger } from "./logger.js";
import type { ReminderStore } from "./reminder-store.js";
import type { TaskStore } from "./task-store.js";
import { nextDailyRunAt } from "./time.js";
import type { ReminderRecord } from "./types.js";

export { nextDailyRunAt } from "./time.js";

type SendMessage = (groupId: string, message: string) => Promise<void>;

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
/** A brief never reaches back further than this, even after quiet days. */
const MAX_BRIEF_WINDOW_MS = 3 * DAY_MS;
const MAX_BRIEF_MESSAGES = 400;

/**
 * Patch only speaks unprompted for reminders a founder explicitly set, plus
 * the opt-in daily brief, which is written from the group's own conversation.
 * There is no periodic task digest.
 */
interface SchedulerOptions {
  reminders: ReminderStore;
  tasks: Pick<TaskStore, "listOpen">;
  conversation?: Pick<ConversationStore, "list" | "hasHumanMessages" | "prune">;
  conversationRetentionDays?: number;
  timezone: string;
  logger: Logger;
  pollIntervalMs?: number;
  founderBrief?: {
    time: string;
    groupIds: ReadonlySet<string>;
    generate: (input: FounderBriefInput) => Promise<string>;
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
  private lastPruneMs = 0;

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

      this.pruneConversation(nowMs);
      await this.sendFounderBriefs(nowMs, send);
    } finally {
      this.running = false;
    }
  }

  private pruneConversation(nowMs: number): void {
    const days = this.options.conversationRetentionDays;
    if (!this.options.conversation || !days || nowMs - this.lastPruneMs < HOUR_MS) return;
    this.lastPruneMs = nowMs;
    try {
      const removed = this.options.conversation.prune(nowMs - days * DAY_MS);
      if (removed > 0) {
        this.options.logger.info({ removed, days }, "Pruned old conversation messages");
      }
    } catch (error) {
      this.options.logger.error({ error }, "Failed to prune the conversation log");
    }
  }

  private async sendFounderBriefs(
    nowMs: number,
    send: SendMessage,
  ): Promise<void> {
    const brief = this.options.founderBrief;
    const conversation = this.options.conversation;
    if (!brief || !conversation || brief.groupIds.size === 0) return;
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

    const nextRun = nextDailyRunAt(nowMs + 60_000, brief.time, this.options.timezone);
    const groupsWithNews = dueGroups.filter((groupId) => {
      const sinceMs = this.briefWindowStart(groupId, nowMs);
      if (conversation.hasHumanMessages(groupId, sinceMs, nowMs)) return true;
      // Nothing was said, so there is nothing to brief on. Keep the window
      // open so tomorrow's brief still covers today.
      this.options.reminders.setNextRun(`founder_brief:${groupId}`, nextRun);
      this.options.logger.info({ groupId }, "Skipped daily brief: the group was quiet");
      return false;
    });
    if (groupsWithNews.length === 0) return;

    const tasks = await this.options.tasks.listOpen();
    for (const groupId of groupsWithNews) {
      try {
        const sinceMs = this.briefWindowStart(groupId, nowMs);
        const messages = conversation.list(groupId, {
          sinceMs,
          untilMs: nowMs,
          limit: MAX_BRIEF_MESSAGES,
        });
        const output = await brief.generate({
          conversation: messages,
          tasks,
          reminders: this.options.reminders.listActive(groupId, 50),
          sinceMs,
          untilMs: nowMs,
        });
        await send(groupId, output);
        this.options.reminders.setNextRun(`founder_brief:${groupId}`, nextRun);
        this.options.reminders.setNextRun(`founder_brief_since:${groupId}`, nowMs);
        this.options.logger.info(
          { groupId, messageCount: messages.length, taskCount: tasks.tasks.length, output },
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

  /** Start of the conversation a brief covers: since the last brief, capped. */
  private briefWindowStart(groupId: string, nowMs: number): number {
    const lastBrief = this.options.reminders.getOrCreateNextRun(
      `founder_brief_since:${groupId}`,
      nowMs - DAY_MS,
    );
    return Math.max(lastBrief, nowMs - MAX_BRIEF_WINDOW_MS);
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
