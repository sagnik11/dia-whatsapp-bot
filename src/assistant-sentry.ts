import { z } from "zod";
import { optionalText, resolveSince } from "./integration-common.js";
import { IntegrationError } from "./integration-http.js";
import type { ToolDefinition } from "./llm.js";
import type { SentryClient } from "./sentry-client.js";
import type { ToolModule, ToolSession } from "./tool-module.js";
import { ToolArgumentError, output, type ToolOutcome } from "./tool-outcome.js";

const sentryIssuesSchema = z.object({ since: z.string().trim().min(2).max(40), project: optionalText(100) });

export const SENTRY_TOOLS: readonly ToolDefinition[] = [
  {
    name: "sentry_issues",
    description:
      "Read-only Sentry digest: unresolved issues that are new or regressed since a moment, with event and user counts and links, busiest first.",
    parameters: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO 8601 date/datetime, or a span like 24h, 7d." },
        project: { type: "string", description: "Project slug; omit for every configured project." },
      },
      required: ["since"],
      additionalProperties: false,
    },
  },
];

export const SENTRY_INSTRUCTIONS: readonly string[] = [
  "Sentry (read-only, on request only): use sentry_issues for 'any new errors?' or 'what broke since the deploy?'. Lead with the busiest issues, give counts and links, and never claim to have resolved or assigned anything.",
];

export function isSentryRequest(message: string): boolean {
  return /\bsentry\b|\b(?:new|regressed|production|prod) (?:errors?|issues|exceptions|crashes)\b|\bwhat broke\b/i.test(message);
}

export interface SentryToolsOptions {
  sentry: Pick<SentryClient, "newOrRegressed">;
  /** Configured project slugs; the tool never reads any other project. */
  projects: readonly string[];
  timezone: string;
  now?: () => number;
}

export class SentryTools implements ToolModule {
  public readonly name = "sentry";
  public readonly tools = SENTRY_TOOLS;
  public readonly instructions = SENTRY_INSTRUCTIONS;

  public constructor(private readonly options: SentryToolsOptions) {}

  public detect(message: string): boolean {
    return isSentryRequest(message);
  }

  public begin(): ToolSession {
    return { handle: (name, args) => (name === "sentry_issues" ? this.issues(args) : Promise.resolve(null)) };
  }

  private async issues(args: unknown): Promise<ToolOutcome> {
    const parsed = sentryIssuesSchema.parse(args);
    const since = resolveSince(parsed.since, this.options.timezone, this.options.now?.() ?? Date.now());
    let projects = this.options.projects;
    if (parsed.project) {
      const wanted = parsed.project.toLowerCase();
      const found = projects.find((project) => project.toLowerCase() === wanted);
      if (!found) throw new ToolArgumentError(`project must be one of: ${projects.join(", ")}`);
      projects = [found];
    }
    const results = await Promise.all(
      projects.map(async (project) => {
        try {
          const issues = await this.options.sentry.newOrRegressed(project, since);
          return { project, count: issues.length, issues: issues.slice(0, 15) };
        } catch (error) {
          if (error instanceof IntegrationError) return { project, error: error.message };
          throw error;
        }
      }),
    );
    return output({ since, projects: results });
  }
}
