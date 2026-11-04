import type { ConversationLog } from "./conversation-store.js";
import type { FollowUpStore } from "./follow-up-store.js";
import type { FounderBriefInput } from "./founder-brief.js";
import type { Logger } from "./logger.js";
import type { MemoryStore } from "./memory-store.js";
import type { ReminderStore } from "./reminder-store.js";
import type { TaskStore } from "./task-store.js";
import { nextDailyRunAt, nextWeeklyRunAt } from "./time.js";
import type { ScheduledJob } from "./tool-module.js";
import type { WeeklyReviewInput } from "./weekly-review.js";
import type { ReminderRecord } from "./types.js";

export { nextDailyRunAt } from "./time.js";

type SendMessage = (groupId: string, message: string) => Promise<void>;

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
/** A brief never reaches back further than this, even after quiet days. */
const MAX_BRIEF_WINDOW_MS = 3 * DAY_MS;
const MAX_BRIEF_MESSAGES = 400;
const WEEK_MS = 7 * DAY_MS;
const RECURRING_CHECK_MS = 15 * 60 * 1_000;
/** A failed brief or review waits this long instead of retrying every tick. */
const RETRY_MS = 15 * 60 * 1_000;

/**
 * Patch only speaks unprompted for reminders a founder explicitly set, plus
 * the opt-in daily brief, which is written from the group's own conversation.
 * There is no periodic task digest.
 */
interface SchedulerOptions {
  reminders: ReminderStore;
  tasks: Pick<TaskStore, "listOpen">;
  conversation?: Pick<ConversationLog, "list" | "hasHumanMessages" | "prune">;
  conversationRetentionDays?: number;
  timezone: string;
  logger: Logger;
  pollIntervalMs?: number;
  founderBrief?: {
    time: string;
    groupIds: ReadonlySet<string>;
    generate: (input: FounderBriefInput) => Promise<string>;
  };
  /** Monday review written from last week's conversation and work. */
  weeklyReview?: {
    weekday: number;
    time: string;
    groupIds: ReadonlySet<string>;
    tasks: Pick<TaskStore, "listOpen" | "listClosedSince">;
    followUps: Pick<FollowUpStore, "list">;
    memory: Pick<MemoryStore, "search">;
    generate: (input: WeeklyReviewInput) => Promise<string>;
  };
  /** Silent nightly job that distills the conversation into long-term memory. */
  memoryJob?: {
    time: string;
    /** Groups worth distilling: those where founders talked recently. */
    groups: (sinceMs: number) => Promise<readonly string[]>;
    run: (groupId: string, sinceMs: number, untilMs: number) => Promise<number>;
  };
  /** Silent job that adds tasks from recurring templates. */
  recurringJob?: {
    run: (nowMs: number) => Promise<number>;
  };
  /** Plug-in jobs from capability modules, each run at most once per interval. */
  jobs?: readonly ScheduledJob[];
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
  private lastRecurringCheckMs = 0;
  private readonly lastJobRunMs = new Map<string, number>();

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

      await this.pruneConversation(nowMs);
      // Each job is isolated so one failing service cannot block the others.
      await this.guard("founder brief", () => this.sendFounderBriefs(nowMs, send));
      await this.guard("Monday review", () => this.sendWeeklyReviews(nowMs, send));
      await this.guard("recurring tasks", () => this.runRecurring(nowMs));
      await this.guard("memory distillation", () => this.runMemoryJob(nowMs));
      for (const job of this.options.jobs ?? []) {
        if (nowMs - (this.lastJobRunMs.get(job.name) ?? 0) < job.intervalMs) continue;
        this.lastJobRunMs.set(job.name, nowMs);
        await this.guard(job.name, () => job.run(nowMs, send));
      }
    } finally {
      this.running = false;
    }
  }

  private async pruneConversation(nowMs: number): Promise<void> {
    const days = this.options.conversationRetentionDays;
    if (!this.options.conversation || !days || nowMs - this.lastPruneMs < HOUR_MS) return;
    this.lastPruneMs = nowMs;
    try {
      const removed = await this.options.conversation.prune(nowMs - days * DAY_MS);
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
    const groupsWithNews: string[] = [];
    for (const groupId of dueGroups) {
      const sinceMs = this.briefWindowStart(groupId, nowMs);
      if (await conversation.hasHumanMessages(groupId, sinceMs, nowMs)) {
        groupsWithNews.push(groupId);
        continue;
      }
      // Nothing was said, so there is nothing to brief on. Keep the window
      // open so tomorrow's brief still covers today.
      this.options.reminders.setNextRun(`founder_brief:${groupId}`, nextRun);
      this.options.logger.info({ groupId }, "Skipped daily brief: the group was quiet");
    }
    if (groupsWithNews.length === 0) return;

    const tasks = await this.options.tasks.listOpen();
    for (const groupId of groupsWithNews) {
      try {
        const sinceMs = this.briefWindowStart(groupId, nowMs);
        const messages = await conversation.list(groupId, {
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
        this.options.reminders.setNextRun(`founder_brief:${groupId}`, nowMs + RETRY_MS);
        this.options.logger.error(
          { error, groupId },
          "Failed to send founder brief; retrying in 15 minutes",
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

  private async guard(name: string, job: () => Promise<void>): Promise<void> {
    try {
      await job();
    } catch (error) {
      this.options.logger.error({ error, job: name }, "Scheduled job failed; it will be retried");
    }
  }

  private async sendWeeklyReviews(nowMs: number, send: SendMessage): Promise<void> {
    const review = this.options.weeklyReview;
    const conversation = this.options.conversation;
    if (!review || !conversation || review.groupIds.size === 0) return;
    const key = (groupId: string) => `weekly_review:${groupId}`;
    const dueGroups = [...review.groupIds].filter(
      (groupId) =>
        this.options.reminders.getOrCreateNextRun(
          key(groupId),
          nextWeeklyRunAt(nowMs, review.weekday, review.time, this.options.timezone),
        ) <= nowMs,
    );
    if (dueGroups.length === 0) return;

    const sinceMs = nowMs - WEEK_MS;
    const nextRun = nextWeeklyRunAt(nowMs + 60_000, review.weekday, review.time, this.options.timezone);
    const [openTasks, closedTasks, followUps] = await Promise.all([
      review.tasks.listOpen(),
      review.tasks.listClosedSince(new Date(sinceMs).toISOString()),
      review.followUps.list({ statuses: ["open"], owner: null, counterparty: null, dueTo: null, limit: 50 }),
    ]);
    for (const groupId of dueGroups) {
      const talked = await conversation.hasHumanMessages(groupId, sinceMs, nowMs);
      if (!talked && closedTasks.length === 0) {
        this.options.reminders.setNextRun(key(groupId), nextRun);
        this.options.logger.info({ groupId }, "Skipped Monday review: nothing happened last week");
        continue;
      }
      try {
        const output = await review.generate({
          conversation: await conversation.list(groupId, { sinceMs, untilMs: nowMs, limit: 600 }),
          closedTasks,
          openTasks,
          followUps,
          memories: await review.memory.search(groupId, {
            text: null,
            kind: null,
            sinceIso: new Date(sinceMs).toISOString(),
            limit: 80,
          }),
          sinceMs,
          untilMs: nowMs,
        });
        await send(groupId, output);
        this.options.reminders.setNextRun(key(groupId), nextRun);
        this.options.logger.info({ groupId, output }, "Sent Monday review");
      } catch (error) {
        this.options.reminders.setNextRun(key(groupId), nowMs + RETRY_MS);
        this.options.logger.error({ error, groupId }, "Failed to send Monday review; retrying in 15 minutes");
      }
    }
  }

  private async runRecurring(nowMs: number): Promise<void> {
    const job = this.options.recurringJob;
    if (!job || nowMs - this.lastRecurringCheckMs < RECURRING_CHECK_MS) return;
    this.lastRecurringCheckMs = nowMs;
    const created = await job.run(nowMs);
    if (created > 0) this.options.logger.info({ created }, "Added tasks from recurring templates");
  }

  private async runMemoryJob(nowMs: number): Promise<void> {
    const job = this.options.memoryJob;
    if (!job) return;
    for (const groupId of await job.groups(nowMs - MAX_BRIEF_WINDOW_MS)) {
      const runKey = `memory_distill:${groupId}`;
      if (
        this.options.reminders.getOrCreateNextRun(
          runKey,
          nextDailyRunAt(nowMs, job.time, this.options.timezone),
        ) > nowMs
      ) {
        continue;
      }
      const sinceKey = `memory_distill_since:${groupId}`;
      const sinceMs = Math.max(
        this.options.reminders.getOrCreateNextRun(sinceKey, nowMs - DAY_MS),
        nowMs - MAX_BRIEF_WINDOW_MS,
      );
      try {
        const added = await job.run(groupId, sinceMs, nowMs);
        this.options.reminders.setNextRun(sinceKey, nowMs);
        this.options.reminders.setNextRun(
          runKey,
          nextDailyRunAt(nowMs + 60_000, job.time, this.options.timezone),
        );
        this.options.logger.info({ groupId, added }, "Distilled conversation into long-term memory");
      } catch (error) {
        this.options.reminders.setNextRun(runKey, nowMs + HOUR_MS);
        this.options.logger.error({ error, groupId }, "Memory distillation failed; retrying in an hour");
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
