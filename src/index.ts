import { join } from "node:path";
import { DiaAssistant } from "./assistant.js";
import { WhatsAppBot } from "./bot.js";
import { D1HttpClient } from "./cloudflare-d1.js";
import { config } from "./config.js";
import { ContextBuffer } from "./context-buffer.js";
import { DedupeStore } from "./dedupe-store.js";
import { CloudflareMarkdownConverter } from "./document-converter.js";
import { FounderBriefGenerator } from "./founder-brief.js";
import { CloudflareGatewayModel } from "./llm.js";
import { createLogger } from "./logger.js";
import { MediaIngestionService } from "./media-ingestion.js";
import { NotionSpendService } from "./notion-spend.js";
import { NotionWorkspaceService } from "./notion.js";
import { ReminderStore } from "./reminder-store.js";
import { ResearchAgent } from "./research-agent.js";
import { ProactiveScheduler } from "./scheduler.js";
import { TaskStore } from "./task-store.js";
import { TavilyWebSearchService } from "./web-search.js";

const logger = createLogger(config.logLevel);
const databasePath = join(config.dataDir, "dia.sqlite");
const dedupe = new DedupeStore(databasePath);
const reminders = new ReminderStore(databasePath);

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
const tasks = new TaskStore({
  db: new D1HttpClient({
    accountId: config.cloudflareAccountId,
    databaseId: config.d1DatabaseId,
    apiToken: config.d1ApiToken,
    logger,
  }),
  timezone: config.timezone,
  logger,
});
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
  ...(notion ? { notion } : {}),
  ...(notionSpend ? { notionSpend } : {}),
  reminders,
  ...(webSearch ? { webSearch } : {}),
  ...(researchAgent ? { researchAgent } : {}),
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
  ? new FounderBriefGenerator({ llm, timezone: config.timezone, logger })
  : undefined;
const scheduler = new ProactiveScheduler({
  reminders,
  tasks,
  timezone: config.timezone,
  logger,
  ...(founderBrief && config.founderBriefTime
    ? {
        founderBrief: {
          time: config.founderBriefTime,
          groupIds: config.founderBriefGroupIds,
          generate: (openTasks, activeReminders) =>
            founderBrief.generate(openTasks, activeReminders),
        },
      }
    : {}),
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
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function start(): Promise<void> {
  // Fail fast with a clear error if D1 credentials or the database id are wrong.
  await tasks.ensureSchema();
  logger.info(
    {
      model: config.aiModel,
      fallbackModel: config.aiFallbackModel ?? null,
      gateway: config.aiGatewayId,
      brainDump: Boolean(notion?.canReadBrainDump),
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
  process.exitCode = 1;
});
