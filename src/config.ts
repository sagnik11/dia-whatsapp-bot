import "dotenv/config";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const isTime = (value: string | undefined) =>
  !value || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

/** A daily time that is on by default; an explicitly empty value turns it off. */
const defaultOnTime = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) => value.trim() || undefined)
    .refine(isTime, "Time must use 24-hour HH:mm format");

const booleanFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((value) => value === "true");

const workersAiModel = (name: string) =>
  z
    .string()
    .trim()
    .refine(
      (value) => value === "" || value.startsWith("@cf/") || value.startsWith("@hf/"),
      `${name} must be a Workers AI model id such as @cf/moonshotai/kimi-k2.6`,
    );

const schema = z
  .object({
    CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1, "CLOUDFLARE_ACCOUNT_ID is required"),
    CLOUDFLARE_API_TOKEN: z
      .string()
      .trim()
      .min(1, "CLOUDFLARE_API_TOKEN (Workers AI Read + D1 Edit) is required"),
    CLOUDFLARE_AI_GATEWAY_ID: z.string().trim().min(1).default("default"),
    CLOUDFLARE_AI_MODEL: workersAiModel("CLOUDFLARE_AI_MODEL")
      .refine((value) => value !== "", "CLOUDFLARE_AI_MODEL cannot be empty")
      .default("@cf/moonshotai/kimi-k2.6"),
    CLOUDFLARE_AI_FALLBACK_MODEL: workersAiModel("CLOUDFLARE_AI_FALLBACK_MODEL").default(
      "@cf/google/gemma-4-26b-a4b-it",
    ),
    CLOUDFLARE_AI_REASONING_EFFORT: z.enum(["", "none", "high"]).default("none"),
    CLOUDFLARE_AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
    CLOUDFLARE_D1_DATABASE_ID: z
      .string()
      .trim()
      .min(1, "CLOUDFLARE_D1_DATABASE_ID is required for the task list"),
    CLOUDFLARE_D1_API_TOKEN: optionalString,
    CLOUDFLARE_DOCUMENT_CONVERSION: booleanFlag("true"),
    WHISPER_TRANSCRIPTION_URL: optionalString,
    WHISPER_LANGUAGE: z.string().min(1).default("auto"),
    WHISPER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(180_000),
    NOTION_API_KEY: optionalString,
    NOTION_BRAIN_DUMP_PAGE_ID: optionalString,
    NOTION_KNOWLEDGE_ENABLED: booleanFlag("false"),
    NOTION_SCRIPT_SOURCE_MAP_JSON: z.string().default("{}"),
    NOTION_SCRIPT_SERIES_NAME: z.string().min(1).default("Dekhte Hai"),
    NOTION_SPEND_DATA_SOURCE_ID: optionalString,
    NOTION_SPEND_PAYER_MAP_JSON: optionalString,
    // Legacy name kept so existing deployments' payer maps keep working.
    NOTION_ASSIGNEE_MAP_JSON: z.string().default("{}"),
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
    // Days of group conversation kept locally for briefs and look-backs; 0 turns it off.
    CONVERSATION_RETENTION_DAYS: z.coerce.number().int().min(0).max(365).default(90),
    // On by default (founders' decision); set it empty to turn the brief off.
    FOUNDER_BRIEF_TIME: defaultOnTime("09:00"),
    FOUNDER_BRIEF_GROUP_IDS: z.string().default(""),
    MEDIA_MAX_BYTES: z.coerce.number().int().min(1).max(25_000_000).default(5_000_000),
    LIST_GROUPS_ON_START: booleanFlag("true"),
    DATA_DIR: z.string().default(".data"),
    LOG_LEVEL: z.string().default("info"),
    PUPPETEER_EXECUTABLE_PATH: optionalString,
  })
  .superRefine((env, context) => {
    const needsNotion =
      env.NOTION_BRAIN_DUMP_PAGE_ID ||
      env.NOTION_SPEND_DATA_SOURCE_ID ||
      env.NOTION_KNOWLEDGE_ENABLED ||
      env.NOTION_SCRIPT_SOURCE_MAP_JSON.trim() !== "{}";
    if (env.FOUNDER_BRIEF_TIME && env.CONVERSATION_RETENTION_DAYS === 0) {
      context.addIssue({
        code: "custom",
        path: ["FOUNDER_BRIEF_TIME"],
        message:
          "The daily brief is written from the group conversation; set CONVERSATION_RETENTION_DAYS above 0 or clear FOUNDER_BRIEF_TIME",
      });
    }
    if (needsNotion && !env.NOTION_API_KEY) {
      context.addIssue({
        code: "custom",
        path: ["NOTION_API_KEY"],
        message:
          "NOTION_API_KEY is required when the Brain Dump, spend log, knowledge, or script library is configured",
      });
    }
  });

const env = schema.parse(process.env);

function parsePersonMap(value: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(value);
  const validated = z.record(z.string(), z.string().min(1)).parse(parsed);
  return Object.fromEntries(
    Object.entries(validated).map(([name, id]) => [name.trim().toLowerCase(), id.trim()]),
  );
}

function parseScriptSourceMap(
  value: string,
): ReadonlyArray<{ dataSourceId: string; titleProperty: string }> {
  const parsed: unknown = JSON.parse(value);
  const validated = z.record(z.string().min(1), z.string().min(1)).parse(parsed);
  return Object.entries(validated).map(([dataSourceId, titleProperty]) => ({
    dataSourceId: dataSourceId.trim(),
    titleProperty: titleProperty.trim(),
  }));
}

function parseIdSet(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

const allowedGroupIds = parseIdSet(env.ALLOWED_GROUP_IDS);
const configuredBriefGroupIds = parseIdSet(env.FOUNDER_BRIEF_GROUP_IDS);

export const config = {
  cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
  cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
  aiGatewayId: env.CLOUDFLARE_AI_GATEWAY_ID,
  aiModel: env.CLOUDFLARE_AI_MODEL,
  aiFallbackModel: env.CLOUDFLARE_AI_FALLBACK_MODEL || undefined,
  aiReasoningEffort: env.CLOUDFLARE_AI_REASONING_EFFORT || undefined,
  aiTimeoutMs: env.CLOUDFLARE_AI_TIMEOUT_MS,
  d1DatabaseId: env.CLOUDFLARE_D1_DATABASE_ID,
  d1ApiToken: env.CLOUDFLARE_D1_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN,
  documentConversionEnabled: env.CLOUDFLARE_DOCUMENT_CONVERSION,
  whisperTranscriptionUrl: env.WHISPER_TRANSCRIPTION_URL,
  whisperLanguage: env.WHISPER_LANGUAGE,
  whisperTimeoutMs: env.WHISPER_TIMEOUT_MS,
  notionApiKey: env.NOTION_API_KEY,
  notionBrainDumpPageId: env.NOTION_BRAIN_DUMP_PAGE_ID,
  notionKnowledgeEnabled: env.NOTION_KNOWLEDGE_ENABLED,
  notionScriptSources: parseScriptSourceMap(env.NOTION_SCRIPT_SOURCE_MAP_JSON),
  notionScriptSeriesName: env.NOTION_SCRIPT_SERIES_NAME,
  notionSpendDataSourceId: env.NOTION_SPEND_DATA_SOURCE_ID,
  notionSpendPayerMap: parsePersonMap(
    env.NOTION_SPEND_PAYER_MAP_JSON ?? env.NOTION_ASSIGNEE_MAP_JSON,
  ),
  tavilyApiKey: env.TAVILY_API_KEY,
  researchMaxSearches: env.RESEARCH_MAX_SEARCHES,
  botName: env.BOT_NAME,
  botTrigger: env.BOT_TRIGGER,
  timezone: env.TIMEZONE,
  allowedGroupIds,
  authorizedUserIds: parseIdSet(env.AUTHORIZED_USER_IDS),
  unauthorizedReply: env.UNAUTHORIZED_REPLY,
  contextMessageLimit: env.CONTEXT_MESSAGE_LIMIT,
  conversationRetentionDays: env.CONVERSATION_RETENTION_DAYS,
  founderBriefTime: env.FOUNDER_BRIEF_TIME,
  founderBriefGroupIds:
    configuredBriefGroupIds.size > 0 ? configuredBriefGroupIds : allowedGroupIds,
  mediaMaxBytes: env.MEDIA_MAX_BYTES,
  listGroupsOnStart: env.LIST_GROUPS_ON_START,
  dataDir: env.DATA_DIR,
  logLevel: env.LOG_LEVEL,
  puppeteerExecutablePath: env.PUPPETEER_EXECUTABLE_PATH,
} as const;
