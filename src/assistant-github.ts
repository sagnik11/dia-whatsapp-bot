import { z } from "zod";
import type { GitHubClient, PullSummary } from "./github-client.js";
import { optionalText, resolveSince } from "./integration-common.js";
import { IntegrationError, integrationFailure } from "./integration-http.js";
import type { ToolDefinition } from "./llm.js";
import type { ToolModule, ToolSession } from "./tool-module.js";
import { ToolArgumentError, output, type ToolOutcome } from "./tool-outcome.js";

const activitySchema = z.object({ repo: optionalText(140), since: z.string().trim().min(2).max(40) });
const releaseNotesSchema = z.object({
  repo: z.string().trim().min(1).max(140),
  since_tag: z
    .string()
    .trim()
    .regex(/^[\w.\-/]{1,100}$/, "must be a tag name such as v1.4.0")
    .nullish(),
});

export const GITHUB_TOOLS: readonly ToolDefinition[] = [
  {
    name: "github_activity",
    description:
      "Read-only GitHub digest: PRs merged since a moment, open PRs waiting on review, and failing checks on the default branch. Covers every configured repo unless one is named.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name or just name; omit for all configured repos." },
        since: { type: "string", description: "ISO 8601 date/datetime, or a span like 24h, 7d, 2w." },
      },
      required: ["since"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_release_notes",
    description:
      "Draft release notes from PR titles merged since a tag (default: the latest release or tag), grouped into Features, Fixes and so on. Read-only; nothing is published.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string" },
        since_tag: { type: "string", description: "Tag to start after, e.g. v1.4.0." },
      },
      required: ["repo"],
      additionalProperties: false,
    },
  },
];

export const GITHUB_INSTRUCTIONS: readonly string[] = [
  "GitHub (read-only, on request only): use github_activity for 'what merged / what's waiting on review / is CI red' and draft_release_notes for release notes. Link PRs by number, keep it short, and never claim to have published or merged anything.",
];

export function isGitHubRequest(message: string): boolean {
  return /\bgithub\b|\bpull requests?\b|\bPRs?\b|\bmerged\b|\brelease notes?\b|\bchangelog\b|\bCI\b|\bfailing (?:checks?|builds?|tests?)\b/i.test(message);
}

const GROUPS: ReadonlyArray<[string, RegExp]> = [
  ["Features", /^(?:feat|feature)$/],
  ["Fixes", /^(?:fix|bugfix|hotfix)$/],
  ["Performance", /^perf$/],
  ["Docs", /^docs?$/],
  ["Maintenance", /^(?:chore|ci|build|refactor|test|tests|style|deps)$/],
];

/** Puts a PR into a release-notes group by its conventional-commit prefix or labels. */
export function releaseGroup(pull: Pick<PullSummary, "title" | "labels">): { group: string; title: string } {
  const prefix = /^(\w+)(?:\([^)]*\))?!?:\s*/.exec(pull.title);
  const type = prefix?.[1]?.toLowerCase() ?? "";
  const title = pull.title.slice(prefix?.[0].length ?? 0).trim();
  const tidy = title ? title.charAt(0).toUpperCase() + title.slice(1) : pull.title;
  const byPrefix = GROUPS.find(([, pattern]) => pattern.test(type))?.[0];
  if (byPrefix) return { group: byPrefix, title: tidy };
  const labels = pull.labels.map((label) => label.toLowerCase());
  if (labels.some((label) => /bug|fix/.test(label))) return { group: "Fixes", title: tidy };
  if (labels.some((label) => /feature|enhancement/.test(label))) return { group: "Features", title: tidy };
  if (labels.some((label) => /doc/.test(label))) return { group: "Docs", title: tidy };
  return { group: "Other changes", title: tidy };
}

function pullLine(pull: PullSummary) {
  return { number: pull.number, title: pull.title, author: pull.author, url: pull.url, mergedAt: pull.mergedAt };
}

export interface GitHubToolsOptions {
  github: Pick<GitHubClient, "mergedPulls" | "openPulls" | "defaultBranch" | "failingChecks" | "latestTag" | "refDate">;
  /** Configured owner/name repos; the tools never read any other repo. */
  repos: readonly string[];
  timezone: string;
  now?: () => number;
}

const DAY_MS = 86_400_000;

export class GitHubTools implements ToolModule {
  public readonly name = "github";
  public readonly tools = GITHUB_TOOLS;
  public readonly instructions = GITHUB_INSTRUCTIONS;

  public constructor(private readonly options: GitHubToolsOptions) {}

  public detect(message: string): boolean {
    return isGitHubRequest(message);
  }

  public begin(): ToolSession {
    return { handle: (name, args) => this.handle(name, args) };
  }

  public async handle(name: string, args: unknown): Promise<ToolOutcome | null> {
    if (name === "github_activity") return this.activity(args);
    if (name === "draft_release_notes") return this.releaseNotes(args);
    return null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Resolves "name" or "owner/name" to a configured repo, refusing anything else. */
  private repo(value: string): string {
    const wanted = value.trim().toLowerCase().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    const found = this.options.repos.find(
      (repo) => repo.toLowerCase() === wanted || repo.toLowerCase().split("/")[1] === wanted,
    );
    if (!found) throw new ToolArgumentError(`repo must be one of the configured repos: ${this.options.repos.join(", ")}`);
    return found;
  }

  private async activity(args: unknown): Promise<ToolOutcome> {
    const parsed = activitySchema.parse(args);
    const since = resolveSince(parsed.since, this.options.timezone, this.now());
    const repos = parsed.repo ? [this.repo(parsed.repo)] : this.options.repos.slice(0, 5);
    const now = this.now();
    const results = await Promise.all(
      repos.map(async (repo) => {
        try {
          const [merged, open, branch] = await Promise.all([
            this.options.github.mergedPulls(repo, since),
            this.options.github.openPulls(repo),
            this.options.github.defaultBranch(repo),
          ]);
          const failing = await this.options.github.failingChecks(repo, branch);
          return {
            repo,
            merged: merged.slice(0, 30).map(pullLine),
            mergedCount: merged.length,
            awaitingReview: open.slice(0, 20).map((pull) => ({
              number: pull.number,
              title: pull.title,
              author: pull.author,
              url: pull.url,
              requestedReviewers: pull.requestedReviewers,
              ageDays: Math.floor((now - Date.parse(pull.createdAt)) / DAY_MS),
            })),
            defaultBranch: branch,
            failingChecks: failing,
          };
        } catch (error) {
          if (error instanceof IntegrationError) return { repo, error: error.message };
          throw error;
        }
      }),
    );
    return output({ since, repos: results });
  }

  private async releaseNotes(args: unknown): Promise<ToolOutcome> {
    const parsed = releaseNotesSchema.parse(args);
    const repo = this.repo(parsed.repo);
    try {
      const tag = parsed.since_tag ?? (await this.options.github.latestTag(repo));
      const since = tag ? await this.options.github.refDate(repo, tag) : null;
      const merged = await this.options.github.mergedPulls(repo, since);
      const groups: Record<string, string[]> = {};
      for (const pull of [...merged].reverse()) {
        const { group, title } = releaseGroup(pull);
        (groups[group] ??= []).push(`${title} (#${pull.number}${pull.author ? `, @${pull.author}` : ""})`);
      }
      const order = ["Features", "Fixes", "Performance", "Docs", "Maintenance", "Other changes"];
      const draft = order
        .filter((group) => groups[group]?.length)
        .map((group) => [`### ${group}`, ...(groups[group] ?? []).map((line) => `- ${line}`)].join("\n"))
        .join("\n\n");
      return output({
        repo,
        sinceTag: tag,
        since,
        count: merged.length,
        groups,
        draft: draft || "No merged pull requests since then.",
        note: "A draft for the founders to edit; nothing was published.",
      });
    } catch (error) {
      return integrationFailure(error, "Reading GitHub");
    }
  }
}
