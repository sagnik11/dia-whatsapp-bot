import { join } from "node:path";
import { createIntegrationModules } from "./assistant-integrations.js";
import { Phase1Tools } from "./assistant-phase1.js";
import { DiaAssistant } from "./assistant.js";
import { WhatsAppBot } from "./bot.js";
import { ChecklistStore } from "./checklist-store.js";
import { D1HttpClient } from "./cloudflare-d1.js";
import { config, integrationsConfig } from "./config.js";
import { ContextBuffer } from "./context-buffer.js";
import { ConversationStore } from "./conversation-store.js";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "./d1-schema.js";
import { DedupeStore } from "./dedupe-store.js";
import { CloudflareMarkdownConverter } from "./document-converter.js";
import { FollowUpStore } from "./follow-up-store.js";
import { FounderBriefGenerator, type FounderBriefInput } from "./founder-brief.js";
import { CloudflareGatewayModel } from "./llm.js";
import { createLogger } from "./logger.js";
import { MediaIngestionService } from "./media-ingestion.js";
import { MemoryDistiller, distillGroupMemory } from "./memory-distiller.js";
import { MemoryStore } from "./memory-store.js";
import { NotionSpendService } from "./notion-spend.js";
import { NotionWorkspaceService } from "./notion.js";
import { ReminderStore } from "./reminder-store.js";
import { ResearchAgent } from "./research-agent.js";
import { RecurringTaskStore, materializeRecurringTasks } from "./recurring-store.js";
import { ProactiveScheduler } from "./scheduler.js";
import { TaskStore } from "./task-store.js";
import { TavilyWebSearchService } from "./web-search.js";
import { WeeklyReviewGenerator, type WeeklyReviewInput } from "./weekly-review.js";

const logger = createLogger(config.logLevel);
const databasePath = join(config.dataDir, "dia.sqlite");
const dedupe = new DedupeStore(databasePath);
const reminders = new ReminderStore(databasePath);
const conversation =
  config.conversationRetentionDays > 0 ? new ConversationStore(databasePath) : undefined;

const llm = new CloudflareGatewayModel({
  accountId: config.cloudflareAccountId,
  gatewayId: config.aiGatewayId,
  apiToken: config.cloudflareApiToken,
  model: config.aiModel,
  ...(config.aiFallbackModel ? { fallbackModel: config.aiFallbackModel } : {}),
  ...(config.aiReasoningEffort ? { reasoningEffort: config.aiReasoningEffort } : {}),
  timeoutMs: config.aiTimeoutMs,
  logger,
});
const d1 = new D1HttpClient({
  accountId: config.cloudflareAccountId,
  databaseId: config.d1DatabaseId,
  apiToken: config.d1ApiToken,
  logger,
});
const tasks = new TaskStore({ db: d1, timezone: config.timezone, logger });
// Phase 1: long-term memory, follow-ups, recurring tasks, checklists.
const phase1Schema = new SchemaGate(d1, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
const memory = new MemoryStore({ db: d1, schema: phase1Schema, logger });
const followUps = new FollowUpStore({ db: d1, schema: phase1Schema, timezone: config.timezone, logger });
const recurring = new RecurringTaskStore({ db: d1, schema: phase1Schema, timezone: config.timezone, logger });
const checklists = new ChecklistStore({ db: d1, schema: phase1Schema, logger });
const phase1 = new Phase1Tools({ memory, followUps, recurring, checklists }, tasks, config.timezone, logger);
// Phase 3: Gmail, Calendar, GitHub and Sentry tools, each only when configured.
const integrations = createIntegrationModules(integrationsConfig, {
  db: d1,
  memory,
  followUps,
  tasks,
  timezone: config.timezone,
  logger,
});
const backgroundReasoning = config.aiBackgroundReasoningEffort
  ? { reasoningEffort: config.aiBackgroundReasoningEffort }
  : {};
const notion = config.notionApiKey
  ? new NotionWorkspaceService({
      apiKey: config.notionApiKey,
      ...(config.notionBrainDumpPageId
        ? { brainDumpPageId: config.notionBrainDumpPageId }
        : {}),
      knowledgeEnabled: config.notionKnowledgeEnabled,
      scriptSources: config.notionScriptSources,
      scriptSeriesName: config.notionScriptSeriesName,
      logger,
    })
  : undefined;
const notionSpend =
  config.notionApiKey && config.notionSpendDataSourceId
    ? new NotionSpendService({
        apiKey: config.notionApiKey,
        dataSourceId: config.notionSpendDataSourceId,
        payerMap: config.notionSpendPayerMap,
        logger,
      })
    : undefined;
const webSearch = config.tavilyApiKey
  ? new TavilyWebSearchService({ apiKey: config.tavilyApiKey, logger })
  : undefined;
const researchAgent = webSearch
  ? new ResearchAgent({
      llm,
      timezone: config.timezone,
      maxSearches: config.researchMaxSearches,
      webSearch,
      logger,
    })
  : undefined;
const assistant = new DiaAssistant({
  llm,
  botName: config.botName,
  timezone: config.timezone,
  tasks,
  ...(conversation ? { conversation } : {}),
  ...(notion ? { notion } : {}),
  ...(notionSpend ? { notionSpend } : {}),
  reminders,
  ...(webSearch ? { webSearch } : {}),
  ...(researchAgent ? { researchAgent } : {}),
  // Capability modules, in priority order. New phases register theirs here.
  modules: [phase1, ...integrations],
  checklists,
  logger,
});
const mediaIngestion = new MediaIngestionService({
  ...(config.whisperTranscriptionUrl
    ? { transcriptionUrl: config.whisperTranscriptionUrl }
    : {}),
  transcriptionLanguage: config.whisperLanguage,
  transcriptionTimeoutMs: config.whisperTimeoutMs,
  maxBytes: config.mediaMaxBytes,
  ...(config.documentConversionEnabled
    ? {
        documentConverter: new CloudflareMarkdownConverter({
          accountId: config.cloudflareAccountId,
          apiToken: config.cloudflareApiToken,
          logger,
        }),
      }
    : {}),
  logger,
});
const founderBrief = config.founderBriefTime
  ? new FounderBriefGenerator({ llm, timezone: config.timezone, ...backgroundReasoning, logger })
  : undefined;
const weeklyReview = config.weeklyReviewTime
  ? new WeeklyReviewGenerator({ llm, timezone: config.timezone, ...backgroundReasoning, logger })
  : undefined;
const distiller = new MemoryDistiller({ llm, timezone: config.timezone, ...backgroundReasoning, logger });
const scheduler = new ProactiveScheduler({
  reminders,
  tasks,
  ...(conversation
    ? { conversation, conversationRetentionDays: config.conversationRetentionDays }
    : {}),
  timezone: config.timezone,
  logger,
  ...(founderBrief && config.founderBriefTime
    ? {
        founderBrief: {
          time: config.founderBriefTime,
          groupIds: config.founderBriefGroupIds,
          generate: (input: FounderBriefInput) => founderBrief.generate(input),
        },
      }
    : {}),
  ...(weeklyReview && config.weeklyReviewTime
    ? {
        weeklyReview: {
          weekday: config.weeklyReviewWeekday,
          time: config.weeklyReviewTime,
          groupIds: config.founderBriefGroupIds,
          tasks,
          followUps,
          memory,
          generate: (input: WeeklyReviewInput) => weeklyReview.generate(input),
        },
      }
    : {}),
  ...(conversation && config.memoryDistillTime
    ? {
        memoryJob: {
          time: config.memoryDistillTime,
          groups: (sinceMs: number) => conversation.activeGroups(sinceMs),
          run: (groupId: string, sinceMs: number, untilMs: number) =>
            distillGroupMemory({ groupId, sinceMs, untilMs, conversation, memory, distiller }),
        },
      }
    : {}),
  recurringJob: {
    run: (nowMs: number) =>
      materializeRecurringTasks({ recurring, tasks, timezone: config.timezone, nowMs, logger }),
  },
});
const bot = new WhatsAppBot({
  assistant,
  context: new ContextBuffer(config.contextMessageLimit),
  dedupe,
  allowedGroupIds: config.allowedGroupIds,
  authorizedUserIds: config.authorizedUserIds,
  unauthorizedReply: config.unauthorizedReply,
  botName: config.botName,
  botTrigger: config.botTrigger,
  dataDir: config.dataDir,
  listGroupsOnStart: config.listGroupsOnStart,
  mediaIngestion,
  ...(conversation ? { conversation } : {}),
  scheduler,
  ...(config.puppeteerExecutablePath
    ? { puppeteerExecutablePath: config.puppeteerExecutablePath }
    : {}),
  logger,
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down");
  await bot.stop().catch((error: unknown) => {
    logger.error({ error }, "Failed to close WhatsApp client cleanly");
  });
  dedupe.close();
  reminders.close();
  conversation?.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function start(): Promise<void> {
  // Fail fast with a clear error if D1 credentials or the database id are wrong.
  await Promise.all([tasks.ensureSchema(), phase1Schema.ensure()]);
  logger.info(
    {
      model: config.aiModel,
      fallbackModel: config.aiFallbackModel ?? null,
      gateway: config.aiGatewayId,
      brainDump: Boolean(notion?.canReadBrainDump),
      conversationRetentionDays: config.conversationRetentionDays,
      dailyBrief: config.founderBriefTime ?? "off",
      weeklyReview: config.weeklyReviewTime ? `${config.weeklyReviewWeekday}@${config.weeklyReviewTime}` : "off",
      memoryDistill: config.memoryDistillTime ?? "off",
      spendLog: Boolean(notionSpend),
    },
    "Chief-of-staff services configured",
  );
  await bot.start();
}

start().catch(async (error: unknown) => {
  logger.fatal({ error }, `${config.botName} failed to start`);
  await bot.stop().catch(() => undefined);
  dedupe.close();
  reminders.close();
  conversation?.close();
  process.exitCode = 1;
});
