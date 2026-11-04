import { z } from "zod";
import { fetchJson, parseResponse } from "./integration-http.js";

const SERVICE = "Sentry";

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  project: string;
  level: string | null;
  events: number;
  users: number;
  firstSeen: string;
  lastSeen: string;
  /** "new" when first seen inside the window, otherwise "regressed". */
  reason: "new" | "regressed";
  link: string;
}

const issueSchema = z.object({
  id: z.string(),
  shortId: z.string().default(""),
  title: z.string(),
  culprit: z.string().nullish(),
  permalink: z.string().default(""),
  level: z.string().nullish(),
  count: z.coerce.number().default(0),
  userCount: z.coerce.number().default(0),
  firstSeen: z.string(),
  lastSeen: z.string(),
  project: z.object({ slug: z.string() }).nullish(),
});

/** Sentry search wants UTC datetimes without milliseconds or a zone suffix. */
function searchDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19);
}

/** Read-only Sentry calls: unresolved issues that are new or regressed since a moment. */
export class SentryClient {
  public constructor(
    private readonly options: { token: string; org: string; baseUrl?: string; timeoutMs?: number },
  ) {}

  private async issues(project: string, query: string): Promise<Array<z.infer<typeof issueSchema>>> {
    const base = (this.options.baseUrl ?? "https://sentry.io").replace(/\/+$/, "");
    const params = new URLSearchParams({ query, sort: "freq", limit: "25" });
    const raw = await fetchJson(
      SERVICE,
      `${base}/api/0/projects/${encodeURIComponent(this.options.org)}/${encodeURIComponent(project)}/issues/?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${this.options.token}` },
        ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      },
    );
    return parseResponse(SERVICE, z.array(issueSchema), raw);
  }

  public async newOrRegressed(project: string, sinceIso: string): Promise<SentryIssue[]> {
    const since = searchDate(sinceIso);
    const [fresh, regressed] = await Promise.all([
      this.issues(project, `is:unresolved firstSeen:>=${since}`),
      this.issues(project, `is:unresolved is:regressed lastSeen:>=${since}`),
    ]);
    const byId = new Map<string, SentryIssue>();
    for (const [reason, list] of [["new", fresh], ["regressed", regressed]] as const) {
      for (const issue of list) {
        if (byId.has(issue.id)) continue;
        byId.set(issue.id, {
          id: issue.id,
          shortId: issue.shortId,
          title: issue.title.slice(0, 200),
          culprit: issue.culprit ?? null,
          project: issue.project?.slug ?? project,
          level: issue.level ?? null,
          events: issue.count,
          users: issue.userCount,
          firstSeen: issue.firstSeen,
          lastSeen: issue.lastSeen,
          reason,
          link: issue.permalink,
        });
      }
    }
    return [...byId.values()].sort((a, b) => b.events - a.events);
  }
}
