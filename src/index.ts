import { join } from "node:path";
import { createIntegrationModules } from "./assistant-integrations.js";
import { ExportTools } from "./assistant-export.js";
import { createAdminOps } from "./assistant-admin.js";
import { FinanceTools } from "./assistant-finance.js";
import { Phase1Tools } from "./assistant-phase1.js";
import { DiaAssistant } from "./assistant.js";
import { SemanticTools } from "./assistant-semantic.js";
import { WhatsAppBot } from "./bot.js";
import { ChecklistStore } from "./checklist-store.js";
import { D1HttpClient, type SqlExecutor } from "./cloudflare-d1.js";
import { adminConfig, config, financeConfig, integrationsConfig, platformConfig } from "./config.js";
import { ContextBuffer } from "./context-buffer.js";
import { ConversationStore, type ConversationLog } from "./conversation-store.js";
import {
  CONVERSATION_SCHEMA_STATEMENTS,
  D1ConversationStore,
  moveLocalConversationToD1,
} from "./conversation-store-d1.js";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "./d1-schema.js";
import { DedupeStore } from "./dedupe-store.js";
import { CloudflareMarkdownConverter } from "./document-converter.js";
import { coreExportSources } from "./export-sources.js";
import { BudgetStore, FINANCE_SCHEMA_STATEMENTS, SubscriptionStore } from "./finance-store.js";
import { FollowUpStore } from "./follow-up-store.js";
import { FounderBriefGenerator, type FounderBriefInput } from "./founder-brief.js";
import { CloudflareGatewayModel } from "./llm.js";
import { createLogger } from "./logger.js";
import { MediaIngestionService } from "./media-ingestion.js";
import { MemoryDistiller, distillGroupMemory } from "./memory-distiller.js";
import { MemoryStore } from "./memory-store.js";
import { NotionSpendService } from "./notion-spend.js";
import { NotionWorkspaceService } from "./notion.js";
import {
  FileArchive,
  PatchApiSqlExecutor,
  SemanticIndex,
  createAttachmentArchiver,
} from "./patch-api-client.js";
import { ReminderStore } from "./reminder-store.js";
import { ResearchAgent } from "./research-agent.js";
import { RecurringTaskStore, materializeRecurringTasks } from "./recurring-store.js";
import { ProactiveScheduler } from "./scheduler.js";
import { TaskStore } from "./task-store.js";
import { VectorSyncJob } from "./vector-sync.js";
import { VoiceTools } from "./assistant-voice.js";
import { TaskAssigner } from "./task-assignment.js";
import { PEOPLE_SCHEMA_STATEMENTS, PeopleStore } from "./people-store.js";
import { SetupInterview } from "./setup-interview.js";
import { VoiceLearningJob } from "./voice.js";
import { TavilyWebSearchService } from "./web-search.js";
import { WeeklyReviewGenerator, type WeeklyReviewInput } from "./weekly-review.js";

const logger = createLogger(config.logLevel);
const databasePath = join(config.dataDir, "dia.sqlite");
const dedupe = new DedupeStore(databasePath);
const reminders = new ReminderStore(databasePath);
const localConversation =
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
// Phase 3: with PATCH_API_URL set, every store reaches D1 through the Worker's binding.
const patchApi = platformConfig.patchApi;
const d1: SqlExecutor = patchApi
  ? new PatchApiSqlExecutor({ ...patchApi, logger })
  : new D1HttpClient({
      accountId: config.cloudflareAccountId,
      databaseId: config.d1DatabaseId,
      apiToken: config.d1ApiToken,
      logger,
    });
const tasks = new TaskStore({ db: d1, timezone: config.timezone, logger });
// The group conversation: D1 once the Worker is configured (founders' decision),
// otherwise local SQLite on this server.
const conversationSchema = new SchemaGate(d1, CONVERSATION_SCHEMA_STATEMENTS, logger, "Conversation");
const d1Conversation =
  localConversation && platformConfig.conversationInD1
    ? new D1ConversationStore({ db: d1, schema: conversationSchema, logger })
    : undefined;
const conversation: ConversationLog | undefined = d1Conversation ?? localConversation;
// Phase 1: long-term memory, follow-ups, recurring tasks, checklists.
const phase1Schema = new SchemaGate(d1, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
const memory = new MemoryStore({ db: d1, schema: phase1Schema, logger });
const followUps = new FollowUpStore({ db: d1, schema: phase1Schema, timezone: config.timezone, logger });
const recurring = new RecurringTaskStore({ db: d1, schema: phase1Schema, timezone: config.timezone, logger });
const checklists = new ChecklistStore({ db: d1, schema: phase1Schema, logger });
// Everyone in the group: profiles, setup and writing voice, and a private memory beside the shared one.
const peopleSchema = new SchemaGate(d1, PEOPLE_SCHEMA_STATEMENTS, logger, "People");
const people = new PeopleStore({ db: d1, schema: peopleSchema, logger });
const phase1 = new Phase1Tools({ memory, followUps, recurring, checklists, people }, tasks, config.timezone, logger);
// Phase 3: Gmail, Calendar, GitHub and Sentry tools, each only when configured.
const integrations = createIntegrationModules(integrationsConfig, {
  db: d1,
  memory,
  followUps,
  tasks,
  timezone: config.timezone,
  logger,
});
// Phase 2 reporting: CSV exports sent as WhatsApp documents. Other modules can
// add datasets with exportTools.registry.register(...).
const exportTools = new ExportTools(
  coreExportSources({ db: d1, tasks, phase1Schema, checklists }),
  config.timezone,
  logger,
);
// Phase 2 admin and ops: compliance register, metrics, pipelines, investor update.
const adminOps = adminConfig.enabled
  ? createAdminOps({
      db: d1,
      tasks,
      memory,
      llm,
      timezone: config.timezone,
      complianceLeadDays: adminConfig.complianceLeadDays,
      pipelineStaleDays: adminConfig.pipelineStaleDays,
      logger,
    })
  : undefined;
// Phase 3: semantic memory (Vectorize) and the R2 attachment archive, each opt-in.
const semanticIndex =
  patchApi && platformConfig.semanticMemory ? new SemanticIndex({ ...patchApi, logger }) : undefined;
const archiveAttachment =
  patchApi && platformConfig.archiveAttachments
    ? createAttachmentArchiver(new FileArchive({ ...patchApi, logger }), config.timezone)
    : undefined;
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
// Semantic search covers founders' messages once the conversation is in D1,
// and the Brain Dump whenever it is configured.
const semantic = semanticIndex
  ? new SemanticTools({
      index: semanticIndex,
      db: d1,
      logger,
      messages: Boolean(d1Conversation),
      people,
      brainDump: Boolean(notion?.canReadBrainDump),
    })
  : undefined;
const vectorSync = semanticIndex
  ? new VectorSyncJob({
      db: d1,
      index: semanticIndex,
      logger,
      ...(d1Conversation ? { conversation: conversationSchema } : {}),
      ...(notion?.canReadBrainDump ? { brainDump: { read: (options) => notion.readBrainDump(options) } } : {}),
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
// Phase 2 money: subscriptions and budgets in D1; roll-ups read the spend log when configured.
const financeSchema = new SchemaGate(d1, FINANCE_SCHEMA_STATEMENTS, logger, "Finance");
const finance = new FinanceTools(
  {
    subscriptions: new SubscriptionStore({ db: d1, schema: financeSchema, timezone: config.timezone, logger }),
    budgets: new BudgetStore({ db: d1, schema: financeSchema, timezone: config.timezone, logger }),
    ...(notionSpend ? { spendLog: notionSpend } : {}),
  },
  { companyPaymentMethods: financeConfig.companyPaymentMethods, logger },
);
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
// Each person on the allowlist: their profile, `@patch setup` interview and writing voice.
const voiceTools = new VoiceTools({ people, ...(conversation ? { conversation } : {}), logger });
const setupInterview = new SetupInterview({ people, llm, logger });
const voiceLearning = new VoiceLearningJob({
  people,
  llm,
  logger,
  ...(conversation ? { conversation } : {}),
  ...backgroundReasoning,
});
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
  modules: [
    phase1,
    voiceTools,
    finance,
    ...(adminOps ? [adminOps.module] : []),
    ...(semantic ? [semantic] : []),
    exportTools,
    ...integrations,
  ],
  checklists,
  // Tasks nobody assigned get an owner from roles, shared memory and past tasks.
  assignOwners: new TaskAssigner({ llm, tasks, people, memory, logger }),
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
            distillGroupMemory({ groupId, sinceMs, untilMs, conversation, memory, distiller, people }),
        },
      }
    : {}),
  recurringJob: {
    run: (nowMs: number) =>
      materializeRecurringTasks({ recurring, tasks, timezone: config.timezone, nowMs, logger }),
  },
  jobs: [voiceLearning, ...(adminOps ? [adminOps.job] : []), ...(vectorSync ? [vectorSync] : [])],
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
  setup: setupInterview,
  ...(archiveAttachment ? { archiveAttachment } : {}),
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
  localConversation?.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function start(): Promise<void> {
  // Fail fast with a clear error if D1 credentials or the database id are wrong.
  await Promise.all([tasks.ensureSchema(), phase1Schema.ensure(), adminOps?.schema.ensure()]);
  if (d1Conversation && localConversation) {
    // One-time move of the history kept locally before the switch to D1.
    await moveLocalConversationToD1({
      local: localConversation,
      d1: d1Conversation,
      sinceMs: Date.now() - config.conversationRetentionDays * 86_400_000,
      logger,
    });
  }
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
      d1Route: patchApi ? "patch-api-worker" : "rest-api",
      conversationStore: d1Conversation ? "d1" : localConversation ? "local" : "off",
      semanticMemory: Boolean(semantic),
      archiveAttachments: Boolean(archiveAttachment),
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
  localConversation?.close();
  process.exitCode = 1;
});
