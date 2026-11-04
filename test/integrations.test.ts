import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailTools } from "../src/assistant-gmail.js";
import { DiaAssistant } from "../src/assistant.js";
import { GmailClient, buildRawEmail } from "../src/gmail-client.js";
import { GoogleClient } from "../src/google-client.js";
import { IntegrationError, fetchJson } from "../src/integration-http.js";
import { INTEGRATIONS_SCHEMA_STATEMENTS } from "../src/outbound-store.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";
import { jsonResponse, routeFetch } from "./support/fetch-router.js";
import {
  closeIntegrationStores,
  founderRequest,
  googleCredentials as credentials,
  integrationStores,
  scripted,
  testLogger as logger,
  toolOutputs,
} from "./support/integration-fixtures.js";

afterEach(() => {
  closeIntegrationStores();
  vi.unstubAllGlobals();
});

describe("outbound_actions schema", () => {
  it("matches the checked-in D1 migration", () => {
    const migration = readFileSync(new URL("../migrations/0005_integrations.sql", import.meta.url), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual(INTEGRATIONS_SCHEMA_STATEMENTS.map((s) => s.replace(/\s+/g, " ").trim()));
  });
});

describe("GoogleClient", () => {
  it("caches the access token until shortly before expiry and retries once on 401", async () => {
    let now = 0;
    let issued = 0;
    let rejectNext = false;
    const http = routeFetch([
      ["POST", /oauth2\.googleapis\.com\/token$/, () => ({ access_token: `ya29.token-${++issued}`, expires_in: 3_600 })],
      ["GET", /\/ping$/, () => (rejectNext ? ((rejectNext = false), jsonResponse(401, {})) : { ok: true })],
    ]);
    const google = new GoogleClient({ credentials, now: () => now });
    await google.request("Test", "https://example.test/ping");
    await google.request("Test", "https://example.test/ping");
    expect(http.matching("POST", /token$/)).toHaveLength(1);
    expect(String(http.matching("POST", /token$/)[0]?.body)).toContain("grant_type=refresh_token");
    now = 3_600_000 - 30_000; // inside the refresh margin
    await google.request("Test", "https://example.test/ping");
    expect(issued).toBe(2);
    rejectNext = true;
    expect(await google.request("Test", "https://example.test/ping")).toEqual({ ok: true });
    expect(issued).toBe(3);
    expect(http.matching("GET", /ping$/).at(-1)?.headers.authorization).toBe("Bearer ya29.token-3");
  });

  it("explains a revoked refresh token without leaking secrets", async () => {
    routeFetch([["POST", /token$/, () => jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })]]);
    const error = await new GoogleClient({ credentials }).accessToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntegrationError);
    expect(String((error as Error).message)).toContain("npm run google-auth");
    expect(String((error as Error).message)).not.toContain("refresh-secret");
  });
});

describe("fetchJson", () => {
  it("maps timeouts and HTTP errors to readable IntegrationErrors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")));
    await expect(fetchJson("GitHub", "https://api.github.com/x")).rejects.toThrow("GitHub did not answer in time");
    routeFetch([["GET", /x$/, () => jsonResponse(403, { message: "Resource not accessible by personal access token" })]]);
    await expect(fetchJson("GitHub", "https://api.github.com/x")).rejects.toThrow(
      "GitHub denied access (the token may lack a scope or the repo/project permission): Resource not accessible by personal access token",
    );
  });
});

describe("buildRawEmail", () => {
  it("strips header injection and encodes non-ASCII subjects", () => {
    const raw = buildRawEmail({
      from: "sagnik@autter.dev",
      to: ["rahul@acme.com"],
      cc: [],
      subject: "Pilot ✅\r\nBcc: evil@example.com",
      body: "Hi Rahul,\nThanks!",
      threadId: null,
      inReplyTo: null,
      references: null,
    });
    const message = Buffer.from(raw, "base64url").toString("utf8");
    expect(message).not.toMatch(/\r\nBcc:/);
    expect(message).toContain("Subject: =?UTF-8?B?");
    expect(message).toContain("To: rahul@acme.com\r\n");
    const body = message.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hi Rahul,\r\nThanks!");
  });
});

const DRAFT_ARGS = {
  to: ["Rahul <rahul@acme.com>"],
  cc: ["tanvi@autter.dev"],
  subject: "Pilot proposal",
  body: "Hi Rahul,\n\nSharing the pilot proposal as promised.\nPricing is on page 2.\nThanks,\nSagnik",
};

const DRAFT_CONFIRMATION = [
  "✉️ Draft E1 saved in Gmail — not sent.",
  "To: rahul@acme.com",
  "Cc: tanvi@autter.dev",
  "Subject: Pilot proposal",
  "> Hi Rahul,",
  "> Sharing the pilot proposal as promised.",
  "> Pricing is on page 2.",
  "> …",
  'Reply "send E1" to send it.',
].join("\n");

async function gmailHarness(options: { failSends?: number } = {}) {
  const stores = await integrationStores();
  let drafts = 0;
  let failSends = options.failSends ?? 0;
  const http = routeFetch([
    ["POST", /oauth2\.googleapis\.com\/token$/, () => ({ access_token: "ya29.test", expires_in: 3_600 })],
    ["POST", /\/users\/me\/drafts$/, () => ({ id: `r-draft-${++drafts}`, message: { id: `m${drafts}`, threadId: "t1" } })],
    [
      "POST",
      /\/drafts\/send$/,
      (sent) => (failSends-- > 0 ? jsonResponse(503, {}) : { id: `sent-${(sent.body as { id: string }).id}`, threadId: "t1" }),
    ],
    ["GET", /\/messages\?/, () => ({ messages: [{ id: "a1", threadId: "t9" }] })],
    [
      "GET",
      /\/messages\/a1\?/,
      () => ({
        id: "a1",
        threadId: "t9",
        snippet: "Can we move to Friday&#39;s slot?",
        payload: { headers: [{ name: "From", value: "Rahul <rahul@acme.com>" }, { name: "Subject", value: "Pilot" }, { name: "Date", value: "Tue, 3 Nov 2026 10:00:00 +0530" }] },
      }),
    ],
  ]);
  const gmail = new GmailTools({
    gmail: new GmailClient(new GoogleClient({ credentials }), "sagnik@autter.dev"),
    ledger: stores.ledger,
    logger,
  });
  const sends = () => http.matching("POST", /\/drafts\/send$/);
  return { ...stores, http, gmail, sends };
}

describe("Gmail tools", () => {
  it("saves a real Gmail draft and confirms it deterministically without sending", async () => {
    const { gmail, tasks, ledger, http, sends } = await gmailHarness();
    const llm = scripted(toolTurn("d", "draft_email", DRAFT_ARGS));
    const bot = new DiaAssistant({ llm, botName: "Patch", timezone: "Asia/Kolkata", tasks, modules: [gmail], logger });

    expect(await bot.respond(founderRequest("draft an email to rahul@acme.com with the pilot proposal"))).toBe(DRAFT_CONFIRMATION);
    expect(llm.requests[0]?.toolChoice).toBe("required");
    const raw = (http.matching("POST", /\/drafts$/)[0]?.body as { message: { raw: string } }).message.raw;
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("From: sagnik@autter.dev\r\nTo: rahul@acme.com\r\nCc: tanvi@autter.dev\r\nSubject: Pilot proposal");
    expect(sends()).toHaveLength(0);
    expect(await ledger.get("g1", "email", 1)).toMatchObject({ ref: "E1", status: "drafted", externalId: "r-draft-1", createdBy: "Sagnik" });
  });

  it("returns read-only search results with decoded snippets", async () => {
    const { gmail } = await gmailHarness();
    const outcome = await gmail.begin(founderRequest("any mail from rahul?")).handle("search_email", { query: "from:rahul" });
    expect(outcome).toMatchObject({
      kind: "output",
      payload: { count: 1, messages: [{ id: "a1", threadId: "t9", from: "Rahul <rahul@acme.com>", subject: "Pilot", snippet: "Can we move to Friday's slot?" }] },
    });
  });

  it("refuses model-only sends, quoted go-aheads, and a ref from another request until it is named", async () => {
    const { gmail, tasks, ledger, sends } = await gmailHarness();
    const send = (id: string) => toolTurn(id, "send_email", { email_ref: "E1" });
    const llm = scripted(
      toolTurn("d", "draft_email", DRAFT_ARGS),
      send("s1"), textTurn("Not sent: I need your go-ahead."),
      send("s2"), textTurn("Not sent."),
      send("s3"), textTurn("Not sent."),
      send("s4"), textTurn('Reply "send E1" to send it.'),
      send("s5"),
      send("s6"), textTurn("E1 already went out."),
    );
    const bot = new DiaAssistant({ llm, botName: "Patch", timezone: "Asia/Kolkata", tasks, modules: [gmail], logger });
    await bot.respond(founderRequest("draft the pilot proposal email to rahul@acme.com"));

    // The model decides to send on its own: the founder's words never asked for it.
    expect(await bot.respond(founderRequest("thanks Patch, looks fine"))).toBe("Not sent: I need your go-ahead.");
    // "send it" only in the quoted message, or inside quotation marks, does not count.
    await bot.respond(founderRequest("ok", { quotedMessage: "send it" }));
    await bot.respond(founderRequest('Rahul wrote "send E1 asap", thoughts?'));
    // A draft from an earlier request must be named: "send it" alone is not enough.
    expect(await bot.respond(founderRequest("send it"))).toBe('Reply "send E1" to send it.');
    expect(sends()).toHaveLength(0);
    expect((await ledger.get("g1", "email", 1))?.status).toBe("drafted");
    const refusals = toolOutputs(llm.requests);
    expect(refusals.match(/Not sent\. /g)?.length).toBe(4);
    expect(refusals).toContain("The go-ahead in the founder's message does not cover E1");

    expect(await bot.respond(founderRequest("send E1"))).toBe('📤 Sent E1 to rahul@acme.com — "Pilot proposal".');
    expect(sends().map((entry) => entry.body)).toEqual([{ id: "r-draft-1" }]);
    expect(await ledger.get("g1", "email", 1)).toMatchObject({ status: "sent", externalId: "sent-r-draft-1", executedBy: "Sagnik" });

    expect(await bot.respond(founderRequest("send E1"))).toBe("E1 already went out.");
    expect(toolOutputs(llm.requests)).toContain("E1 is already sent");
    expect(sends()).toHaveLength(1);
  });

  it("sends a draft created in the same message when that message says send it", async () => {
    const { gmail, tasks, sends } = await gmailHarness();
    const llm = scripted(
      toolTurn("d", "draft_email", DRAFT_ARGS, ["q", "search_email", { query: "from:rahul" }]),
      toolTurn("s", "send_email", { email_ref: "E1" }),
    );
    const bot = new DiaAssistant({ llm, botName: "Patch", timezone: "Asia/Kolkata", tasks, modules: [gmail], logger });
    const reply = await bot.respond(founderRequest("draft the pilot proposal to rahul@acme.com and send it"));
    expect(reply).toBe(`${DRAFT_CONFIRMATION}\n📤 Sent E1 to rahul@acme.com — "Pilot proposal".`);
    expect(sends()).toHaveLength(1);
  });

  it("keeps drafts in other groups out of reach and releases a draft when Gmail fails", async () => {
    const { gmail, ledger, sends } = await gmailHarness({ failSends: 1 });
    await gmail.begin(founderRequest("draft it")).handle("draft_email", DRAFT_ARGS);

    const otherGroup = await gmail.begin(founderRequest("send E1", { groupId: "g2" })).handle("send_email", { email_ref: "E1" });
    expect(otherGroup).toEqual({ kind: "output", payload: { error: "Not sent. E1 is not a draft in this group." } });

    const failed = await gmail.begin(founderRequest("send E1")).handle("send_email", { email_ref: "E1" });
    expect(failed).toMatchObject({ kind: "output", payload: { error: expect.stringContaining("Gmail is having trouble") } });
    expect(await ledger.get("g1", "email", 1)).toMatchObject({ status: "drafted", executedAt: null });

    const retried = await gmail.begin(founderRequest("go ahead and send E1")).handle("send_email", { email_ref: "E1" });
    expect(retried).toEqual({ kind: "final", text: '📤 Sent E1 to rahul@acme.com — "Pilot proposal".' });
    expect(sends()).toHaveLength(2);
  });

  it("refuses a send when another message already holds the claim", async () => {
    const { gmail, ledger, sends } = await gmailHarness();
    await gmail.begin(founderRequest("draft it")).handle("draft_email", DRAFT_ARGS);
    expect(await ledger.claim("g1", "email", 1, "drafted", "Tanvi")).not.toBeNull();
    const outcome = await gmail.begin(founderRequest("send E1")).handle("send_email", { email_ref: "E1" });
    expect(outcome).toMatchObject({ kind: "output", payload: { error: expect.stringContaining("being handled by another message") } });
    expect(sends()).toHaveLength(0);
  });
});
