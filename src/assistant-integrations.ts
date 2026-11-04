import { CalendarTools } from "./assistant-calendar.js";
import { GitHubTools } from "./assistant-github.js";
import { GmailTools } from "./assistant-gmail.js";
import { SentryTools } from "./assistant-sentry.js";
import { CalendarClient } from "./calendar-client.js";
import type { SqlExecutor } from "./cloudflare-d1.js";
import { SchemaGate } from "./d1-schema.js";
import type { FollowUpStore } from "./follow-up-store.js";
import { GitHubClient } from "./github-client.js";
import { GmailClient } from "./gmail-client.js";
import { GoogleClient } from "./google-client.js";
import type { Logger } from "./logger.js";
import type { MemoryStore } from "./memory-store.js";
import { INTEGRATIONS_SCHEMA_STATEMENTS, OutboundStore } from "./outbound-store.js";
import { SentryClient } from "./sentry-client.js";
import type { TaskStore } from "./task-store.js";
import type { ToolModule } from "./tool-module.js";

export { CalendarTools } from "./assistant-calendar.js";
export { GitHubTools } from "./assistant-github.js";
export { GmailTools } from "./assistant-gmail.js";
export { SentryTools } from "./assistant-sentry.js";

/** Phase 3 settings; a service is undefined (and its tools absent) unless fully configured. */
export interface IntegrationsConfig {
  google:
    | {
        clientId: string;
        clientSecret: string;
        refreshToken: string;
        accountEmail: string;
        calendarId: string;
        gmail: boolean;
        calendar: boolean;
      }
    | undefined;
  github: { token: string; repos: readonly string[] } | undefined;
  sentry: { token: string; org: string; projects: readonly string[]; baseUrl: string } | undefined;
  timeoutMs: number;
}

export interface IntegrationDeps {
  db: SqlExecutor;
  memory: Pick<MemoryStore, "search">;
  followUps: Pick<FollowUpStore, "list">;
  tasks: Pick<TaskStore, "list">;
  timezone: string;
  logger: Logger;
}

/**
 * Builds the Gmail, Calendar, GitHub and Sentry tool modules that are
 * configured. Nothing here runs on a schedule: every call starts from a
 * founder's message, and sends/bookings pass the go-ahead guard.
 */
export function createIntegrationModules(config: IntegrationsConfig, deps: IntegrationDeps): ToolModule[] {
  const modules: ToolModule[] = [];
  const { google, github, sentry } = config;
  if (google && (google.gmail || google.calendar)) {
    const client = new GoogleClient({
      credentials: { clientId: google.clientId, clientSecret: google.clientSecret, refreshToken: google.refreshToken },
      timeoutMs: config.timeoutMs,
    });
    const schema = new SchemaGate(deps.db, INTEGRATIONS_SCHEMA_STATEMENTS, deps.logger, "Integrations");
    const ledger = new OutboundStore({ db: deps.db, schema, logger: deps.logger });
    if (google.gmail) {
      modules.push(new GmailTools({ gmail: new GmailClient(client, google.accountEmail), ledger, logger: deps.logger }));
    }
    if (google.calendar) {
      modules.push(
        new CalendarTools({
          calendar: new CalendarClient(client, google.calendarId),
          ledger,
          memory: deps.memory,
          followUps: deps.followUps,
          tasks: deps.tasks,
          accountEmail: google.accountEmail,
          timezone: deps.timezone,
          logger: deps.logger,
        }),
      );
    }
  }
  if (github) {
    modules.push(
      new GitHubTools({
        github: new GitHubClient({ token: github.token, timeoutMs: config.timeoutMs }),
        repos: github.repos,
        timezone: deps.timezone,
      }),
    );
  }
  if (sentry) {
    modules.push(
      new SentryTools({
        sentry: new SentryClient({ token: sentry.token, org: sentry.org, baseUrl: sentry.baseUrl, timeoutMs: config.timeoutMs }),
        projects: sentry.projects,
        timezone: deps.timezone,
      }),
    );
  }
  deps.logger.info({ integrations: modules.map((module) => module.name) }, "Phase 3 integrations configured");
  return modules;
}
