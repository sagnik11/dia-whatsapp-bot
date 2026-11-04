import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarTools, prepTerms } from "../src/assistant-calendar.js";
import { CalendarClient, type CalendarEvent } from "../src/calendar-client.js";
import { GoogleClient } from "../src/google-client.js";
import { ToolArgumentError } from "../src/tool-outcome.js";
import type { AssistantRequest } from "../src/types.js";
import { jsonResponse, routeFetch } from "./support/fetch-router.js";
import {
  NOW,
  closeIntegrationStores,
  founderRequest,
  googleCredentials,
  integrationStores,
  testLogger,
} from "./support/integration-fixtures.js";

afterEach(() => {
  closeIntegrationStores();
  vi.unstubAllGlobals();
});

const ACME_EVENT = {
  id: "ev-acme",
  summary: "Acme pilot review",
  start: { dateTime: "2026-11-06T16:00:00+05:30" },
  end: { dateTime: "2026-11-06T16:30:00+05:30" },
  htmlLink: "https://calendar.google.com/event?eid=acme",
  attendees: [
    { email: "sagnik@autter.dev", self: true, organizer: true, responseStatus: "accepted" },
    { email: "rahul@acme.com", displayName: "Rahul Mehta", responseStatus: "needsAction" },
  ],
};

const PROPOSAL = {
  title: "Acme pilot review",
  start: "2026-11-06T16:00",
  end: "2026-11-06T16:30",
  attendees: ["rahul@acme.com"],
  description: "Walk through pilot results",
};

async function calendarHarness(options: { conflictOnInsert?: boolean } = {}) {
  const stores = await integrationStores();
  const inserted: Array<Record<string, unknown>> = [];
  const http = routeFetch([
    ["POST", /oauth2\.googleapis\.com\/token$/, () => ({ access_token: "ya29.test", expires_in: 3_600 })],
    ["GET", /\/calendars\/primary\/events\?/, () => ({ items: [ACME_EVENT] })],
    ["GET", /\/calendars\/primary\/events\/[\w-]+$/, (request) => ({ ...ACME_EVENT, id: request.url.split("/").at(-1) })],
    [
      "POST",
      /\/calendars\/primary\/events\?sendUpdates=all$/,
      (request) => {
        if (options.conflictOnInsert) return jsonResponse(409, { error: { message: "The requested identifier already exists." } });
        const body = request.body as Record<string, unknown>;
        inserted.push(body);
        return { ...body, summary: body.summary, htmlLink: `https://calendar.google.com/event?eid=${String(body.id)}` };
      },
    ],
  ]);
  const calendar = new CalendarTools({
    calendar: new CalendarClient(new GoogleClient({ credentials: googleCredentials })),
    ledger: stores.ledger,
    memory: stores.memory,
    followUps: stores.followUps,
    tasks: stores.tasks,
    accountEmail: "sagnik@autter.dev",
    timezone: "Asia/Kolkata",
    logger: testLogger,
    now: () => Date.parse(NOW),
  });
  const known = new Set<number>();
  const session = (body: string, extra: Partial<AssistantRequest> = {}) => calendar.begin(founderRequest(body, extra), known);
  const bookings = () => http.matching("POST", /\/events\?sendUpdates=all$/);
  return { ...stores, http, calendar, session, inserted, bookings, known };
}

const PROPOSAL_TEXT = [
  "📅 Proposed EV1 — not booked yet.",
  "Acme pilot review",
  "When: Fri, 6 Nov 2026, 4:00 pm – 4:30 pm",
  "With: rahul@acme.com",
  "Notes: Walk through pilot results",
  'Reply "book EV1" to add it to the calendar and email the invites.',
].join("\n");

describe("Calendar tools", () => {
  it("records a proposal without touching the calendar", async () => {
    const { session, ledger, bookings } = await calendarHarness();
    expect(await session("set up a call with Rahul on Friday 4pm").handle("propose_event", PROPOSAL)).toEqual({
      kind: "final",
      text: PROPOSAL_TEXT,
    });
    expect(bookings()).toHaveLength(0);
    expect(await ledger.get("g1", "calendar", 1)).toMatchObject({
      ref: "EV1",
      status: "proposed",
      payload: { startIso: "2026-11-06T10:30:00.000Z", endIso: "2026-11-06T11:00:00.000Z", attendees: ["rahul@acme.com"] },
    });
    await expect(session("x").handle("propose_event", { ...PROPOSAL, start: "2026-11-06" })).rejects.toThrow(ToolArgumentError);
    await expect(session("x").handle("propose_event", { ...PROPOSAL, start: "2026-11-01T10:00", end: "2026-11-01T11:00" })).rejects.toThrow(
      "start is in the past",
    );
  });

  it("books only on an explicit book instruction naming the proposal, once", async () => {
    const { session, ledger, bookings, inserted } = await calendarHarness();
    await session("propose Friday 4pm with Rahul").handle("propose_event", PROPOSAL);
    for (const body of ["looks good", "book it", "don't book EV1 yet", "should we book EV1?"]) {
      const outcome = await session(body).handle("book_event", { event_ref: "EV1" });
      expect(outcome).toMatchObject({ kind: "output", payload: { error: expect.stringMatching(/^Not booked\. /) } });
    }
    const quotedOnly = await session("ok", { quotedMessage: "book EV1" }).handle("book_event", { event_ref: "EV1" });
    const inQuotes = await session('Rahul wrote "book EV1", is that right').handle("book_event", { event_ref: "EV1" });
    const otherGroup = await session("book EV1", { groupId: "g2" }).handle("book_event", { event_ref: "EV1" });
    expect([quotedOnly, inQuotes].map((outcome) => outcome?.kind)).toEqual(["output", "output"]);
    expect(otherGroup).toEqual({ kind: "output", payload: { error: "Not booked. EV1 is not a proposal in this group." } });
    expect(bookings()).toHaveLength(0);

    const booked = await session("book EV1").handle("book_event", { event_ref: "EV1" });
    expect(booked).toEqual({
      kind: "final",
      text: `✅ Booked EV1: Acme pilot review — Fri, 6 Nov 2026, 4:00 pm – 4:30 pm. Invites sent to rahul@acme.com.\nhttps://calendar.google.com/event?eid=${String(inserted[0]?.id)}`,
    });
    expect(inserted[0]).toMatchObject({
      id: expect.stringMatching(/^patchev1\d+$/),
      summary: "Acme pilot review",
      start: { dateTime: "2026-11-06T10:30:00.000Z", timeZone: "Asia/Kolkata" },
      attendees: [{ email: "rahul@acme.com" }],
    });
    expect(await ledger.get("g1", "calendar", 1)).toMatchObject({ status: "booked", executedBy: "Sagnik", externalId: inserted[0]?.id });
    expect(await session("book EV1").handle("book_event", { event_ref: "EV1" })).toMatchObject({
      payload: { error: "Not booked. EV1 is already booked." },
    });
    expect(bookings()).toHaveLength(1);
  });

  it("treats a 409 on the deterministic event id as already booked", async () => {
    const { session, ledger } = await calendarHarness({ conflictOnInsert: true });
    await session("propose").handle("propose_event", PROPOSAL);
    expect(await session("go ahead and book EV1").handle("book_event", { event_ref: "EV1" })).toMatchObject({ kind: "final" });
    expect((await ledger.get("g1", "calendar", 1))?.status).toBe("booked");
  });

  it("gathers attendees, memories, open follow-ups and open tasks for meeting prep", async () => {
    const { session, memory, followUps, tasks, known } = await calendarHarness();
    const source = { sourceAuthor: "Tanvi", sourceMessageId: "m1", observedAt: "2026-10-30T10:00:00.000Z" };
    await memory.add("g1", [
      { kind: "preference", subject: "Rahul", content: "Rahul prefers email over calls.", ...source },
      { kind: "decision", subject: "Acme pilot", content: "Acme pilot pricing is ₹40k a month.", ...source },
    ], "Patch");
    await memory.add("g2", [{ kind: "fact", subject: "Acme", content: "Other group's Acme note.", ...source }], "Patch");
    await followUps.create(
      [{ owner: "Sagnik", counterparty: "Rahul (Acme)", promise: "Send the DPA", dueAt: "2026-11-06", notes: null }],
      { actor: "Sagnik", groupName: "HQ", messageId: "f1" },
    );
    await tasks.create(
      [{ title: "Prepare Acme pilot metrics", notes: null, status: null, priority: null, owner: "Tanvi", area: null, dueAt: null, tags: [] }],
      { actor: "Tanvi", groupName: "HQ", messageId: "t1" },
    );
    const outcome = await session("prep me for the Acme call").handle("prep_meeting", { query: "acme" });
    expect(outcome).toMatchObject({
      kind: "output",
      payload: {
        event: { id: "ev-acme", title: "Acme pilot review", when: "Fri, 6 Nov 2026, 4:00 pm – 4:30 pm" },
        searchedFor: ["Rahul", "Acme"],
        openFollowUps: [{ ref: "F1", promise: "Send the DPA" }],
        openTasks: [{ id: 1, title: "Prepare Acme pilot metrics" }],
      },
    });
    const memories = (outcome as { payload: { memories: Array<{ content: string }> } }).payload.memories.map((m) => m.content);
    expect(memories.sort()).toEqual(["Acme pilot pricing is ₹40k a month.", "Rahul prefers email over calls."]);
    // Listed task ids become known, so a follow-up "mark #1 done" in this request is allowed.
    expect([...known]).toEqual([1]);
  });

  it("validates list ranges and derives lookup terms from attendees", async () => {
    const { session } = await calendarHarness();
    await expect(session("x").handle("list_events", { from: "2026-11-01", to: "2027-03-01" })).rejects.toThrow("at most 62 days");
    expect(await session("what's on my calendar today").handle("list_events", { from: "2026-11-06", to: "2026-11-06" })).toMatchObject({
      kind: "output",
      payload: { count: 1, events: [{ id: "ev-acme", attendees: [{ self: true }, { name: "Rahul Mehta" }] }] },
    });
    const event = (emails: string[]): CalendarEvent => ({
      id: "e", title: "t", start: "", end: "", allDay: false, location: null, description: null, link: null, meetLink: null,
      attendees: emails.map((email) => ({ email, name: null, response: null, self: false, organizer: false })),
    });
    expect(prepTerms(event(["priya.sharma@infosys.co.in", "dev@gmail.com", "tanvi@autter.dev"]), null, "sagnik@autter.dev")).toEqual([
      "Priya",
      "Infosys",
      "Dev",
      "Tanvi",
    ]);
  });
});
