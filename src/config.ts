import "dotenv/config";
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const schema = z.object({
  AI_GATEWAY_API_KEY: z.string().min(1, "AI_GATEWAY_API_KEY is required"),
  AI_GATEWAY_BASE_URL: z.url().default("https://ai-gateway.vercel.sh/v1"),
  AI_GATEWAY_MODEL: z.string().default("openai/gpt-5.6-luna"),
  NOTION_API_KEY: z.string().min(1, "NOTION_API_KEY is required"),
  NOTION_DATA_SOURCE_ID: z.string().min(1, "NOTION_DATA_SOURCE_ID is required"),
  NOTION_TITLE_PROPERTY: z.string().default("Task name"),
  NOTION_STATUS_PROPERTY: z.string().default("Status"),
  NOTION_DEFAULT_STATUS: z.string().default("Not started"),
  NOTION_DUE_DATE_PROPERTY: z.string().default("Due date"),
  NOTION_ASSIGNEE_PROPERTY: z.string().default("Assignee"),
  NOTION_DEFAULT_ASSIGNEE_ID: optionalString,
  NOTION_ASSIGNEE_MAP_JSON: z.string().default("{}"),
  NOTION_PRIORITY_PROPERTY: z.string().default("Priority"),
  NOTION_TASK_TYPE_PROPERTY: z.string().default("Task type"),
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

function parseAssigneeMap(value: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(value);
  const validated = z.record(z.string(), z.string().min(1)).parse(parsed);
  return Object.fromEntries(
    Object.entries(validated).map(([name, id]) => [name.trim().toLowerCase(), id.trim()]),
  );
}

export const config = {
  aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
  aiGatewayBaseUrl: env.AI_GATEWAY_BASE_URL,
  aiGatewayModel: env.AI_GATEWAY_MODEL,
  notionApiKey: env.NOTION_API_KEY,
  notionDataSourceId: env.NOTION_DATA_SOURCE_ID,
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
  notionAssigneeMap: parseAssigneeMap(env.NOTION_ASSIGNEE_MAP_JSON),
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
