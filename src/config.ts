import "dotenv/config";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const optionalTime = optionalString.refine(
  (value) => !value || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value),
  "Time must use 24-hour HH:mm format",
);

const azureOpenAIBaseUrl = z
  .url("AZURE_OPENAI_BASE_URL must be a valid URL")
  .refine(
    (value) => new URL(value).pathname.replace(/\/+$/, "") === "/openai/v1",
    "AZURE_OPENAI_BASE_URL must end with /openai/v1/",
  )
  .transform((value) => `${value.replace(/\/+$/, "")}/`);

const schema = z.object({
  AZURE_OPENAI_API_KEY: z.string().min(1, "AZURE_OPENAI_API_KEY is required"),
  AZURE_OPENAI_BASE_URL: azureOpenAIBaseUrl,
  AZURE_OPENAI_DEPLOYMENT: z
    .string()
    .min(1, "AZURE_OPENAI_DEPLOYMENT is required")
    .refine(
      (value) => !value.startsWith("azure/"),
      "AZURE_OPENAI_DEPLOYMENT must be the Azure deployment name without an azure/ prefix",
    ),
  AZURE_OPENAI_MEDIA_DEPLOYMENT: optionalString.refine(
    (value) => !value?.startsWith("azure/"),
    "AZURE_OPENAI_MEDIA_DEPLOYMENT must be the Azure deployment name without an azure/ prefix",
  ),
  SUPERMEMORY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SUPERMEMORY_BASE_URL: z.url().default("http://supermemory:6767"),
  SUPERMEMORY_API_KEY: optionalString,
  SUPERMEMORY_CONTAINER_TAG: z
    .string()
    .regex(
      /^[A-Za-z0-9._-]{1,100}$/,
      "SUPERMEMORY_CONTAINER_TAG may contain only letters, numbers, dots, underscores, and hyphens",
    )
    .default("autter-company"),
  SUPERMEMORY_RECALL_LIMIT: z.coerce.number().int().min(1).max(50).default(12),
  SUPERMEMORY_RECALL_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  SUPERMEMORY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(20_000),
  WHISPER_TRANSCRIPTION_URL: optionalString,
  WHISPER_LANGUAGE: z.string().min(1).default("auto"),
  WHISPER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(180_000),
  NOTION_API_KEY: z.string().min(1, "NOTION_API_KEY is required"),
  NOTION_DATA_SOURCE_ID: z.string().min(1, "NOTION_DATA_SOURCE_ID is required"),
  NOTION_BRAIN_DUMP_PAGE_ID: optionalString,
  NOTION_KNOWLEDGE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  NOTION_TITLE_PROPERTY: z.string().default("Task name"),
  NOTION_STATUS_PROPERTY: z.string().default("Status"),
  NOTION_DEFAULT_STATUS: z.string().default("Not started"),
  NOTION_DUE_DATE_PROPERTY: z.string().default("Due date"),
  NOTION_ASSIGNEE_PROPERTY: z.string().default("Assignee"),
  NOTION_DEFAULT_ASSIGNEE_ID: optionalString,
  NOTION_ASSIGNEE_MAP_JSON: z.string().default("{}"),
  NOTION_SPEND_DATA_SOURCE_ID: optionalString,
  NOTION_SPEND_PAYER_MAP_JSON: optionalString,
  NOTION_PRIORITY_PROPERTY: z.string().default("Priority"),
  NOTION_TASK_TYPE_PROPERTY: z.string().default("Task type"),
  TAVILY_API_KEY: optionalString,
  RESEARCH_MAX_SEARCHES: z.coerce.number().int().min(1).max(5).default(3),
  BOT_NAME: z.string().default("Captain Patch"),
  BOT_TRIGGER: z.string().default("@patch"),
  TIMEZONE: z.string().default("Asia/Kolkata"),
  ALLOWED_GROUP_IDS: z.string().default(""),
  AUTHORIZED_USER_IDS: z.string().default(""),
  UNAUTHORIZED_REPLY: z
    .string()
    .min(1)
    .default("Harbour's closed — only Autter's founders get the command deck. ⚓"),
  CONTEXT_MESSAGE_LIMIT: z.coerce.number().int().min(0).max(20).default(6),
  TASK_DIGEST_INTERVAL_HOURS: z.coerce.number().min(0).max(168).default(0),
  TASK_DIGEST_GROUP_IDS: z.string().default(""),
  FOUNDER_BRIEF_TIME: optionalTime,
  FOUNDER_BRIEF_GROUP_IDS: z.string().default(""),
  MEDIA_MAX_BYTES: z.coerce.number().int().min(1).max(25_000_000).default(5_000_000),
  NOTION_WEBHOOK_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  NOTION_WEBHOOK_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  NOTION_WEBHOOK_PATH: z.string().regex(/^\//).default("/notion/webhook"),
  NOTION_WEBHOOK_VERIFICATION_TOKEN: optionalString,
  NOTION_NOTIFICATION_GROUP_IDS: z.string().default(""),
  NOTION_NOTIFY_BOT_EVENTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  LIST_GROUPS_ON_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  DATA_DIR: z.string().default(".data"),
  LOG_LEVEL: z.string().default("info"),
  PUPPETEER_EXECUTABLE_PATH: optionalString,
});

const env = schema
  .superRefine((value, context) => {
    if (value.SUPERMEMORY_ENABLED && !value.SUPERMEMORY_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["SUPERMEMORY_API_KEY"],
        message:
          "SUPERMEMORY_API_KEY is required when SUPERMEMORY_ENABLED=true",
      });
    }
  })
  .parse(process.env);

function parseAssigneeMap(value: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(value);
  const validated = z.record(z.string(), z.string().min(1)).parse(parsed);
  return Object.fromEntries(
    Object.entries(validated).map(([name, id]) => [name.trim().toLowerCase(), id.trim()]),
  );
}

function parseIdSet(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

const notionAssigneeMap = parseAssigneeMap(env.NOTION_ASSIGNEE_MAP_JSON);
const allowedGroupIds = parseIdSet(env.ALLOWED_GROUP_IDS);
const configuredDigestGroupIds = parseIdSet(env.TASK_DIGEST_GROUP_IDS);
const configuredBriefGroupIds = parseIdSet(env.FOUNDER_BRIEF_GROUP_IDS);
const configuredNotionNotificationGroupIds = parseIdSet(
  env.NOTION_NOTIFICATION_GROUP_IDS,
);

export const config = {
  azureOpenAIApiKey: env.AZURE_OPENAI_API_KEY,
  azureOpenAIBaseUrl: env.AZURE_OPENAI_BASE_URL,
  azureOpenAIDeployment: env.AZURE_OPENAI_DEPLOYMENT,
  azureOpenAIMediaDeployment:
    env.AZURE_OPENAI_MEDIA_DEPLOYMENT ?? env.AZURE_OPENAI_DEPLOYMENT,
  supermemoryEnabled: env.SUPERMEMORY_ENABLED,
  supermemoryBaseUrl: env.SUPERMEMORY_BASE_URL,
  supermemoryApiKey: env.SUPERMEMORY_API_KEY,
  supermemoryContainerTag: env.SUPERMEMORY_CONTAINER_TAG,
  supermemoryRecallLimit: env.SUPERMEMORY_RECALL_LIMIT,
  supermemoryRecallThreshold: env.SUPERMEMORY_RECALL_THRESHOLD,
  supermemoryTimeoutMs: env.SUPERMEMORY_TIMEOUT_MS,
  whisperTranscriptionUrl: env.WHISPER_TRANSCRIPTION_URL,
  whisperLanguage: env.WHISPER_LANGUAGE,
  whisperTimeoutMs: env.WHISPER_TIMEOUT_MS,
  notionApiKey: env.NOTION_API_KEY,
  notionDataSourceId: env.NOTION_DATA_SOURCE_ID,
  notionBrainDumpPageId: env.NOTION_BRAIN_DUMP_PAGE_ID,
  notionKnowledgeEnabled: env.NOTION_KNOWLEDGE_ENABLED,
  notionProperties: {
    title: env.NOTION_TITLE_PROPERTY,
    status: env.NOTION_STATUS_PROPERTY,
    dueDate: env.NOTION_DUE_DATE_PROPERTY,
    assignee: env.NOTION_ASSIGNEE_PROPERTY,
    priority: env.NOTION_PRIORITY_PROPERTY,
    taskType: env.NOTION_TASK_TYPE_PROPERTY,
  },
  notionDefaultStatus: env.NOTION_DEFAULT_STATUS,
  notionDefaultAssigneeId: env.NOTION_DEFAULT_ASSIGNEE_ID,
  notionAssigneeMap,
  notionSpendDataSourceId: env.NOTION_SPEND_DATA_SOURCE_ID,
  notionSpendPayerMap: env.NOTION_SPEND_PAYER_MAP_JSON
    ? parseAssigneeMap(env.NOTION_SPEND_PAYER_MAP_JSON)
    : notionAssigneeMap,
  tavilyApiKey: env.TAVILY_API_KEY,
  researchMaxSearches: env.RESEARCH_MAX_SEARCHES,
  botName: env.BOT_NAME,
  botTrigger: env.BOT_TRIGGER,
  timezone: env.TIMEZONE,
  allowedGroupIds,
  authorizedUserIds: parseIdSet(env.AUTHORIZED_USER_IDS),
  unauthorizedReply: env.UNAUTHORIZED_REPLY,
  contextMessageLimit: env.CONTEXT_MESSAGE_LIMIT,
  taskDigestIntervalHours: env.TASK_DIGEST_INTERVAL_HOURS,
  taskDigestGroupIds:
    configuredDigestGroupIds.size > 0
      ? configuredDigestGroupIds
      : allowedGroupIds,
  founderBriefTime: env.FOUNDER_BRIEF_TIME,
  founderBriefGroupIds:
    configuredBriefGroupIds.size > 0
      ? configuredBriefGroupIds
      : allowedGroupIds,
  mediaMaxBytes: env.MEDIA_MAX_BYTES,
  notionWebhookEnabled: env.NOTION_WEBHOOK_ENABLED,
  notionWebhookPort: env.NOTION_WEBHOOK_PORT,
  notionWebhookPath: env.NOTION_WEBHOOK_PATH,
  notionWebhookVerificationToken: env.NOTION_WEBHOOK_VERIFICATION_TOKEN,
  notionNotificationGroupIds:
    configuredNotionNotificationGroupIds.size > 0
      ? configuredNotionNotificationGroupIds
      : allowedGroupIds,
  notionNotifyBotEvents: env.NOTION_NOTIFY_BOT_EVENTS,
  listGroupsOnStart: env.LIST_GROUPS_ON_START,
  dataDir: env.DATA_DIR,
  logLevel: env.LOG_LEVEL,
  puppeteerExecutablePath: env.PUPPETEER_EXECUTABLE_PATH,
} as const;
