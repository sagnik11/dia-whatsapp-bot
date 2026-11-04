import { afterEach, describe, expect, it, vi } from "vitest";
import { isCalendarRequest } from "../src/assistant-calendar.js";
import { GitHubTools, isGitHubRequest, releaseGroup } from "../src/assistant-github.js";
import { isEmailRequest } from "../src/assistant-gmail.js";
import { createIntegrationModules, type IntegrationsConfig } from "../src/assistant-integrations.js";
import { SentryTools, isSentryRequest } from "../src/assistant-sentry.js";
import { GitHubClient } from "../src/github-client.js";
import { SentryClient } from "../src/sentry-client.js";
import { ToolArgumentError } from "../src/tool-outcome.js";
import { jsonResponse, routeFetch } from "./support/fetch-router.js";
import { NOW, closeIntegrationStores, integrationStores, testLogger } from "./support/integration-fixtures.js";

afterEach(() => {
  closeIntegrationStores();
  vi.unstubAllGlobals();
});

const pull = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  html_url: `https://github.com/autter/app/pull/${number}`,
  user: { login: "tanvi" },
  labels: [],
  requested_reviewers: [],
  created_at: "2026-11-01T06:00:00Z",
  updated_at: "2026-11-03T06:00:00Z",
  merged_at: null,
  draft: false,
  ...extra,
});

function githubHarness() {
  const http = routeFetch([
    [
      "GET",
      /\/repos\/autter\/app\/pulls\?state=closed/,
      () => [
        pull(12, "feat(digest): add Slack digests", { merged_at: "2026-11-03T05:00:00Z" }),
        pull(11, "Retry failed webhooks", { merged_at: "2026-11-02T05:00:00Z", labels: [{ name: "bug" }], user: { login: "sagnik" } }),
        pull(10, "Abandoned experiment"),
        pull(5, "feat: old feature", { merged_at: "2026-10-01T05:00:00Z", updated_at: "2026-10-01T05:00:00Z" }),
      ],
    ],
    [
      "GET",
      /\/repos\/autter\/app\/pulls\?state=open/,
      () => [pull(13, "Onboarding v2", { requested_reviewers: [{ login: "sagnik" }] }), pull(14, "WIP spike", { draft: true })],
    ],
    ["GET", /\/repos\/autter\/app$/, () => ({ default_branch: "main" })],
    [
      "GET",
      /\/commits\/main\/check-runs/,
      () => ({
        check_runs: [
          { name: "test", conclusion: "failure", html_url: "https://github.com/autter/app/runs/1" },
          { name: "lint", conclusion: "success" },
          { name: "deploy", conclusion: "cancelled" },
        ],
      }),
    ],
    ["GET", /\/commits\/main\/status$/, () => ({ statuses: [{ context: "vercel", state: "error", target_url: null }] })],
    ["GET", /\/releases\/latest$/, () => ({ tag_name: "v1.2.0" })],
    ["GET", /\/commits\/v1\.2\.0$/, () => ({ commit: { committer: { date: "2026-10-31T00:00:00Z" } } })],
  ]);
  const tools = new GitHubTools({
    github: new GitHubClient({ token: "ghp_test" }),
    repos: ["autter/app", "autter/private"],
    timezone: "Asia/Kolkata",
    now: () => Date.parse(NOW),
  });
  return { http, session: tools.begin() };
}

describe("GitHub digests", () => {
  it("reports merged PRs, PRs awaiting review and failing default-branch checks per repo", async () => {
    const { http, session } = githubHarness();
    const outcome = await session.handle("github_activity", { since: "7d" });
    expect(outcome).toMatchObject({
      kind: "output",
      payload: {
        since: "2026-10-28T06:30:00.000Z",
        repos: [
          {
            repo: "autter/app",
            mergedCount: 2,
            merged: [{ number: 12 }, { number: 11 }],
            awaitingReview: [{ number: 13, requestedReviewers: ["sagnik"], ageDays: 3 }],
            defaultBranch: "main",
            failingChecks: [
              { name: "test", conclusion: "failure", url: "https://github.com/autter/app/runs/1" },
              { name: "vercel", conclusion: "error", url: null },
            ],
          },
          { repo: "autter/private", error: expect.stringContaining("GitHub could not find that item") },
        ],
      },
    });
    expect(http.requests[0]?.headers).toMatchObject({ authorization: "Bearer ghp_test", "x-github-api-version": "2022-11-28" });
    await expect(session.handle("github_activity", { since: "7d", repo: "someone/else" })).rejects.toThrow(ToolArgumentError);
    await expect(session.handle("github_activity", { since: "2030-01-01" })).rejects.toThrow("since must be in the past");
  });

  it("drafts grouped release notes since the latest release tag", async () => {
    const { session } = githubHarness();
    const outcome = await session.handle("draft_release_notes", { repo: "app" });
    expect(outcome).toMatchObject({
      kind: "output",
      payload: {
        repo: "autter/app",
        sinceTag: "v1.2.0",
        since: "2026-10-31T00:00:00Z",
        count: 2,
        draft: "### Features\n- Add Slack digests (#12, @tanvi)\n\n### Fixes\n- Retry failed webhooks (#11, @sagnik)",
      },
    });
    expect(releaseGroup({ title: "chore(deps): bump zod", labels: [] })).toEqual({ group: "Maintenance", title: "Bump zod" });
    expect(releaseGroup({ title: "Faster search", labels: ["enhancement"] })).toEqual({ group: "Features", title: "Faster search" });
    expect(releaseGroup({ title: "Misc tidy", labels: [] }).group).toBe("Other changes");
  });
});

const issue = (id: string, count: number, extra: Record<string, unknown> = {}) => ({
  id,
  shortId: `WEB-${id}`,
  title: `Error ${id}`,
  culprit: "app/checkout",
  permalink: `https://autter.sentry.io/issues/${id}/`,
  level: "error",
  count: String(count),
  userCount: 3,
  firstSeen: "2026-11-03T10:00:00Z",
  lastSeen: "2026-11-04T05:00:00Z",
  project: { slug: "web" },
  ...extra,
});

describe("Sentry digests", () => {
  it("merges new and regressed unresolved issues, busiest first, per project", async () => {
    const http = routeFetch([
      [
        "GET",
        /\/api\/0\/projects\/autter\/web\/issues\//,
        (request) =>
          new URL(request.url).searchParams.get("query")?.includes("is:regressed")
            ? [issue("2", 90, { firstSeen: "2026-09-01T00:00:00Z" }), issue("1", 42)]
            : [issue("1", 42)],
      ],
      ["GET", /\/projects\/autter\/api\/issues\//, () => jsonResponse(401, { detail: "Invalid token" })],
    ]);
    const tools = new SentryTools({
      sentry: new SentryClient({ token: "sntrys_test", org: "autter" }),
      projects: ["web", "api"],
      timezone: "Asia/Kolkata",
      now: () => Date.parse(NOW),
    });
    const outcome = await tools.begin().handle("sentry_issues", { since: "24h" });
    expect(outcome).toMatchObject({
      kind: "output",
      payload: {
        since: "2026-11-03T06:30:00.000Z",
        projects: [
          {
            project: "web",
            count: 2,
            issues: [
              { shortId: "WEB-2", reason: "regressed", events: 90, link: "https://autter.sentry.io/issues/2/" },
              { shortId: "WEB-1", reason: "new", events: 42, users: 3 },
            ],
          },
          { project: "api", error: "Sentry rejected the credentials: Invalid token" },
        ],
      },
    });
    const queries = http.requests.map((request) => new URL(request.url).searchParams.get("query"));
    expect(queries).toContain("is:unresolved firstSeen:>=2026-11-03T06:30:00");
    expect(queries).toContain("is:unresolved is:regressed lastSeen:>=2026-11-03T06:30:00");
    expect(http.requests[0]?.headers.authorization).toBe("Bearer sntrys_test");
    await expect(tools.begin().handle("sentry_issues", { since: "24h", project: "billing" })).rejects.toThrow(ToolArgumentError);
  });
});

describe("integration wiring", () => {
  const base: IntegrationsConfig = { google: undefined, github: undefined, sentry: undefined, timeoutMs: 15_000 };
  const google = {
    clientId: "cid", clientSecret: "secret", refreshToken: "refresh", accountEmail: "sagnik@autter.dev",
    calendarId: "primary", gmail: true, calendar: true,
  };

  it("registers only the configured services", async () => {
    const stores = await integrationStores();
    const deps = { ...stores, timezone: "Asia/Kolkata", logger: testLogger };
    const names = (config: IntegrationsConfig) => createIntegrationModules(config, deps).map((module) => module.name);
    expect(names(base)).toEqual([]);
    expect(names({ ...base, github: { token: "t", repos: ["autter/app"] } })).toEqual(["github"]);
    expect(names({ ...base, google: { ...google, gmail: false } })).toEqual(["calendar"]);
    expect(
      names({
        ...base,
        google,
        github: { token: "t", repos: ["autter/app"] },
        sentry: { token: "s", org: "autter", projects: ["web"], baseUrl: "https://sentry.io" },
      }),
    ).toEqual(["gmail", "calendar", "github", "sentry"]);
  });

  it("detects requests that need each integration", () => {
    expect(isEmailRequest("draft an email to Rahul")).toBe(true);
    expect(isEmailRequest("send E12")).toBe(true);
    expect(isCalendarRequest("prep me for the 4pm with Acme")).toBe(true);
    expect(isCalendarRequest("book EV3")).toBe(true);
    expect(isGitHubRequest("what merged this week?")).toBe(true);
    expect(isSentryRequest("any new errors in Sentry?")).toBe(true);
    expect(isEmailRequest("add a task to call Rahul")).toBe(false);
  });
});
