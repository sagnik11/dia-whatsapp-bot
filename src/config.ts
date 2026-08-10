import "dotenv/config";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const schema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_MODEL: z.string().default("gpt-5.6-luna"),
  NOTION_API_KEY: z.string().min(1, "NOTION_API_KEY is required"),
  NOTION_DATA_SOURCE_ID: z.string().min(1, "NOTION_DATA_SOURCE_ID is required"),
  NOTION_TITLE_PROPERTY: z.string().default("Task"),
  NOTION_STATUS_PROPERTY: z.string().default("Status"),
  NOTION_DEFAULT_STATUS: z.string().default("Not started"),
  NOTION_DUE_DATE_PROPERTY: z.string().default("Due date"),
  NOTION_ASSIGNEE_PROPERTY: z.string().default("Assignee"),
  NOTION_REQUESTED_BY_PROPERTY: z.string().default("Requested by"),
  NOTION_SOURCE_GROUP_PROPERTY: z.string().default("Source group"),
  NOTION_SOURCE_MESSAGE_PROPERTY: z.string().default("Source message ID"),
  NOTION_NOTES_PROPERTY: z.string().default("Notes"),
  BOT_NAME: z.string().default("Dia"),
  BOT_TRIGGER: z.string().default("@dia"),
  TIMEZONE: z.string().default("Asia/Kolkata"),
  ALLOWED_GROUP_IDS: z.string().default(""),
  CONTEXT_MESSAGE_LIMIT: z.coerce.number().int().min(0).max(20).default(6),
  LIST_GROUPS_ON_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  DATA_DIR: z.string().default(".data"),
  LOG_LEVEL: z.string().default("info"),
  PUPPETEER_EXECUTABLE_PATH: optionalString,
});

const env = schema.parse(process.env);

export const config = {
  openaiApiKey: env.OPENAI_API_KEY,
  openaiModel: env.OPENAI_MODEL,
  notionApiKey: env.NOTION_API_KEY,
  notionDataSourceId: env.NOTION_DATA_SOURCE_ID,
  notionProperties: {
    title: env.NOTION_TITLE_PROPERTY,
    status: env.NOTION_STATUS_PROPERTY,
    dueDate: env.NOTION_DUE_DATE_PROPERTY,
    assignee: env.NOTION_ASSIGNEE_PROPERTY,
    requestedBy: env.NOTION_REQUESTED_BY_PROPERTY,
    sourceGroup: env.NOTION_SOURCE_GROUP_PROPERTY,
    sourceMessage: env.NOTION_SOURCE_MESSAGE_PROPERTY,
    notes: env.NOTION_NOTES_PROPERTY,
  },
  notionDefaultStatus: env.NOTION_DEFAULT_STATUS,
  botName: env.BOT_NAME,
  botTrigger: env.BOT_TRIGGER,
  timezone: env.TIMEZONE,
  allowedGroupIds: new Set(
    env.ALLOWED_GROUP_IDS.split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  ),
  contextMessageLimit: env.CONTEXT_MESSAGE_LIMIT,
  listGroupsOnStart: env.LIST_GROUPS_ON_START,
  dataDir: env.DATA_DIR,
  logLevel: env.LOG_LEVEL,
  puppeteerExecutablePath: env.PUPPETEER_EXECUTABLE_PATH,
} as const;
