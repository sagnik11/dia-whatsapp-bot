import { join } from "node:path";
import { DiaAssistant } from "./assistant.js";
import { WhatsAppBot } from "./bot.js";
import { config } from "./config.js";
import { ContextBuffer } from "./context-buffer.js";
import { DedupeStore } from "./dedupe-store.js";
import { createLogger } from "./logger.js";
import { NotionTaskService } from "./notion.js";

const logger = createLogger(config.logLevel);
const dedupe = new DedupeStore(join(config.dataDir, "dia.sqlite"));
const notion = new NotionTaskService({
  apiKey: config.notionApiKey,
  dataSourceId: config.notionDataSourceId,
  properties: config.notionProperties,
  defaultStatus: config.notionDefaultStatus,
  defaultAssigneeId: config.notionDefaultAssigneeId,
  assigneeMap: config.notionAssigneeMap,
  logger,
});
const assistant = new DiaAssistant({
  gatewayApiKey: config.aiGatewayApiKey,
  gatewayBaseUrl: config.aiGatewayBaseUrl,
  model: config.aiGatewayModel,
  botName: config.botName,
  timezone: config.timezone,
  notion,
  logger,
});
const bot = new WhatsAppBot({
  assistant,
  context: new ContextBuffer(config.contextMessageLimit),
  dedupe,
  allowedGroupIds: config.allowedGroupIds,
  authorizedUserIds: config.authorizedUserIds,
  unauthorizedReply: config.unauthorizedReply,
  botTrigger: config.botTrigger,
  dataDir: config.dataDir,
  listGroupsOnStart: config.listGroupsOnStart,
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
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

bot.start().catch((error: unknown) => {
  logger.fatal({ error }, "Dia failed to start");
  dedupe.close();
  process.exitCode = 1;
});
