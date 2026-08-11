import { join } from "node:path";
import { DiaAssistant } from "./assistant.js";
import { WhatsAppBot } from "./bot.js";
import { config } from "./config.js";
import { ContextBuffer } from "./context-buffer.js";
import { DedupeStore } from "./dedupe-store.js";
import { createLogger } from "./logger.js";
import { NotionTaskService } from "./notion.js";
import { ReminderStore } from "./reminder-store.js";
import { ProactiveScheduler } from "./scheduler.js";
import { TavilyWebSearchService } from "./web-search.js";

const logger = createLogger(config.logLevel);
const databasePath = join(config.dataDir, "dia.sqlite");
const dedupe = new DedupeStore(databasePath);
const reminders = new ReminderStore(databasePath);
const notion = new NotionTaskService({
  apiKey: config.notionApiKey,
  dataSourceId: config.notionDataSourceId,
  ...(config.notionBrainDumpPageId
    ? { brainDumpPageId: config.notionBrainDumpPageId }
    : {}),
  knowledgeEnabled: config.notionKnowledgeEnabled,
  properties: config.notionProperties,
  defaultStatus: config.notionDefaultStatus,
  defaultAssigneeId: config.notionDefaultAssigneeId,
  assigneeMap: config.notionAssigneeMap,
  logger,
});
const webSearch = config.tavilyApiKey
  ? new TavilyWebSearchService({ apiKey: config.tavilyApiKey, logger })
  : undefined;
const assistant = new DiaAssistant({
  gatewayApiKey: config.aiGatewayApiKey,
  gatewayBaseUrl: config.aiGatewayBaseUrl,
  model: config.aiGatewayModel,
  botName: config.botName,
  timezone: config.timezone,
  notion,
  reminders,
  ...(webSearch ? { webSearch } : {}),
  logger,
});
const scheduler = new ProactiveScheduler({
  reminders,
  notion,
  digestGroupIds: config.taskDigestGroupIds,
  digestIntervalHours: config.taskDigestIntervalHours,
  timezone: config.timezone,
  logger,
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

bot.start().catch((error: unknown) => {
  logger.fatal({ error }, `${config.botName} failed to start`);
  dedupe.close();
  reminders.close();
  process.exitCode = 1;
});
