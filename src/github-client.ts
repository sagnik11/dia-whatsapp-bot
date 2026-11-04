import { z } from "zod";
import { IntegrationError, fetchJson, parseResponse } from "./integration-http.js";

const SERVICE = "GitHub";

export interface PullSummary {
  number: number;
  title: string;
  author: string | null;
  url: string;
  draft: boolean;
  labels: string[];
  requestedReviewers: string[];
  createdAt: string;
  mergedAt: string | null;
}

export interface FailingCheck {
  name: string;
  conclusion: string;
  url: string | null;
}

const pullSchema = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  draft: z.boolean().default(false),
  user: z.object({ login: z.string() }).nullish(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  requested_reviewers: z.array(z.object({ login: z.string() })).default([]),
  requested_teams: z.array(z.object({ slug: z.string() })).default([]),
  created_at: z.string(),
  updated_at: z.string(),
  merged_at: z.string().nullish(),
});
const checkRunsSchema = z.object({
  check_runs: z
    .array(z.object({ name: z.string(), conclusion: z.string().nullish(), html_url: z.string().nullish() }))
    .default([]),
});
const statusSchema = z.object({
  statuses: z
    .array(z.object({ context: z.string(), state: z.string(), target_url: z.string().nullish() }))
    .default([]),
});
const commitSchema = z.object({ commit: z.object({ committer: z.object({ date: z.string() }).nullish() }) });

// Cancelled runs are left out: concurrency groups cancel superseded runs routinely.
const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure", "error"]);

function toPull(raw: z.infer<typeof pullSchema>): PullSummary {
  return {
    number: raw.number,
    title: raw.title,
    author: raw.user?.login ?? null,
    url: raw.html_url,
    draft: raw.draft,
    labels: raw.labels.map((label) => label.name),
    requestedReviewers: [
      ...raw.requested_reviewers.map((reviewer) => reviewer.login),
      ...raw.requested_teams.map((team) => `team:${team.slug}`),
    ],
    createdAt: raw.created_at,
    mergedAt: raw.merged_at ?? null,
  };
}

/** Read-only GitHub REST calls for digests and release notes. */
export class GitHubClient {
  public constructor(private readonly options: { token: string; timeoutMs?: number }) {}

  private get(path: string): Promise<unknown> {
    return fetchJson(SERVICE, `https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "User-Agent": "captain-patch",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    });
  }

  private repoPath(repo: string): string {
    const [owner, name] = repo.split("/");
    return `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
  }

  /** PRs merged at or after `sinceIso`, newest first (from the 100 most recently updated closed PRs). */
  public async mergedPulls(repo: string, sinceIso: string | null): Promise<PullSummary[]> {
    const raw = parseResponse(
      SERVICE,
      z.array(pullSchema),
      await this.get(`${this.repoPath(repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=100`),
    );
    const since = sinceIso ? Date.parse(sinceIso) : Number.NEGATIVE_INFINITY;
    return raw
      .filter((pull) => pull.merged_at && Date.parse(pull.merged_at) >= since)
      .map(toPull)
      .sort((a, b) => Date.parse(b.mergedAt ?? "") - Date.parse(a.mergedAt ?? ""));
  }

  /** Open, non-draft PRs (oldest first): the ones waiting on a review or a merge. */
  public async openPulls(repo: string): Promise<PullSummary[]> {
    const raw = parseResponse(
      SERVICE,
      z.array(pullSchema),
      await this.get(`${this.repoPath(repo)}/pulls?state=open&sort=created&direction=asc&per_page=50`),
    );
    return raw.map(toPull).filter((pull) => !pull.draft);
  }

  public async defaultBranch(repo: string): Promise<string> {
    const raw = parseResponse(SERVICE, z.object({ default_branch: z.string() }), await this.get(this.repoPath(repo)));
    return raw.default_branch;
  }

  /** Failed check runs and commit statuses on the tip of a branch. */
  public async failingChecks(repo: string, branch: string): Promise<FailingCheck[]> {
    const ref = encodeURIComponent(branch);
    const [runs, status] = await Promise.all([
      this.get(`${this.repoPath(repo)}/commits/${ref}/check-runs?per_page=100`),
      this.get(`${this.repoPath(repo)}/commits/${ref}/status`),
    ]);
    return [
      ...parseResponse(SERVICE, checkRunsSchema, runs)
        .check_runs.filter((run) => run.conclusion && FAILED.has(run.conclusion))
        .map((run) => ({ name: run.name, conclusion: run.conclusion ?? "failure", url: run.html_url ?? null })),
      ...parseResponse(SERVICE, statusSchema, status)
        .statuses.filter((entry) => FAILED.has(entry.state))
        .map((entry) => ({ name: entry.context, conclusion: entry.state, url: entry.target_url ?? null })),
    ];
  }

  /** The newest release's tag, else the first listed tag, else null. */
  public async latestTag(repo: string): Promise<string | null> {
    try {
      const release = parseResponse(
        SERVICE,
        z.object({ tag_name: z.string() }),
        await this.get(`${this.repoPath(repo)}/releases/latest`),
      );
      return release.tag_name;
    } catch (error) {
      if (!(error instanceof IntegrationError) || error.status !== 404) throw error;
    }
    const tags = parseResponse(SERVICE, z.array(z.object({ name: z.string() })), await this.get(`${this.repoPath(repo)}/tags?per_page=1`));
    return tags[0]?.name ?? null;
  }

  /** Committer date of the commit a tag, branch or sha points at. */
  public async refDate(repo: string, ref: string): Promise<string | null> {
    const raw = parseResponse(SERVICE, commitSchema, await this.get(`${this.repoPath(repo)}/commits/${encodeURIComponent(ref)}`));
    return raw.commit.committer?.date ?? null;
  }
}
