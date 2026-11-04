import { z } from "zod";
import type { GoogleClient } from "./google-client.js";
import { IntegrationError, parseResponse } from "./integration-http.js";

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars";
const SERVICE = "Google Calendar";

export interface CalendarAttendee {
  email: string;
  name: string | null;
  response: string | null;
  self: boolean;
  organizer: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: CalendarAttendee[];
  location: string | null;
  description: string | null;
  link: string | null;
  meetLink: string | null;
}

export interface NewCalendarEvent {
  /** Client-chosen id (base32hex), so a retried booking cannot create a second event. */
  id: string;
  title: string;
  description: string | null;
  startIso: string;
  endIso: string;
  timezone: string;
  attendees: readonly string[];
}

const when = z.object({ dateTime: z.string().optional(), date: z.string().optional() }).default({});
const eventSchema = z.object({
  id: z.string(),
  summary: z.string().default("(no title)"),
  description: z.string().optional(),
  location: z.string().optional(),
  htmlLink: z.string().optional(),
  hangoutLink: z.string().optional(),
  start: when,
  end: when,
  attendees: z
    .array(
      z.object({
        email: z.string().default(""),
        displayName: z.string().optional(),
        responseStatus: z.string().optional(),
        self: z.boolean().optional(),
        organizer: z.boolean().optional(),
      }),
    )
    .default([]),
});
const listSchema = z.object({ items: z.array(eventSchema).default([]) });

function toEvent(raw: z.infer<typeof eventSchema>): CalendarEvent {
  return {
    id: raw.id,
    title: raw.summary,
    start: raw.start.dateTime ?? raw.start.date ?? "",
    end: raw.end.dateTime ?? raw.end.date ?? "",
    allDay: !raw.start.dateTime,
    attendees: raw.attendees
      .filter((attendee) => attendee.email)
      .map((attendee) => ({
        email: attendee.email,
        name: attendee.displayName ?? null,
        response: attendee.responseStatus ?? null,
        self: attendee.self ?? false,
        organizer: attendee.organizer ?? false,
      })),
    location: raw.location ?? null,
    description: raw.description ? raw.description.slice(0, 1_000) : null,
    link: raw.htmlLink ?? null,
    meetLink: raw.hangoutLink ?? null,
  };
}

/** Google Calendar REST calls: read events, and insert one only when booking. */
export class CalendarClient {
  public constructor(
    private readonly google: GoogleClient,
    private readonly calendarId = "primary",
  ) {}

  private get base(): string {
    return `${CALENDAR}/${encodeURIComponent(this.calendarId)}/events`;
  }

  public async listEvents(timeMinIso: string, timeMaxIso: string, max = 50): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(max),
    });
    const list = parseResponse(SERVICE, listSchema, await this.google.request(SERVICE, `${this.base}?${params.toString()}`));
    return list.items.map(toEvent);
  }

  public async getEvent(id: string): Promise<CalendarEvent> {
    const raw = await this.google.request(SERVICE, `${this.base}/${encodeURIComponent(id)}`);
    return toEvent(parseResponse(SERVICE, eventSchema, raw));
  }

  /**
   * Creates the event and emails invitations (sendUpdates=all). Only book_event
   * calls this, after the go-ahead guard. A 409 means this id was already
   * booked, so the existing event is returned instead of a duplicate.
   */
  public async insertEvent(input: NewCalendarEvent): Promise<CalendarEvent> {
    try {
      const raw = await this.google.request(SERVICE, `${this.base}?sendUpdates=all`, {
        method: "POST",
        body: {
          id: input.id,
          summary: input.title,
          ...(input.description ? { description: input.description } : {}),
          start: { dateTime: input.startIso, timeZone: input.timezone },
          end: { dateTime: input.endIso, timeZone: input.timezone },
          attendees: input.attendees.map((email) => ({ email })),
        },
      });
      return toEvent(parseResponse(SERVICE, eventSchema, raw));
    } catch (error) {
      if (error instanceof IntegrationError && error.status === 409) return this.getEvent(input.id);
      throw error;
    }
  }
}
