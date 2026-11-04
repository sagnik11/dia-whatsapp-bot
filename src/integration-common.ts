import { z } from "zod";
import { resolveDueTimestamp } from "./time.js";
import { ToolArgumentError } from "./tool-outcome.js";

const UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "24h", "7d", "2w", or an ISO 8601 date/datetime (local time when no offset) → ISO instant in the past. */
export function resolveSince(value: string, timezone: string, nowMs: number, field = "since"): string {
  const relative = /^\s*(\d{1,3})\s*([hdw])\s*$/i.exec(value);
  if (relative) {
    return new Date(nowMs - Number(relative[1]) * (UNIT_MS[(relative[2] ?? "d").toLowerCase()] ?? 0)).toISOString();
  }
  const timestamp = resolveDueTimestamp(value, timezone, "start");
  if (timestamp === null) {
    throw new ToolArgumentError(`${field} "${value}" is not an ISO 8601 date/datetime or a span like 7d`);
  }
  if (timestamp > nowMs) throw new ToolArgumentError(`${field} must be in the past`);
  return new Date(timestamp).toISOString();
}

/** An address, also accepting the "Name <address>" form the model often copies from email headers. */
export const emailAddress = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  return (angle?.[1] ?? value).trim().toLowerCase();
}, z.email());

export const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || null);

/** "Thu, 6 Nov 2026, 4:00 pm – 4:30 pm" in the group's timezone. */
export function formatRange(startIso: string, endIso: string, timezone: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return `${startIso} – ${endIso}`;
  // Assembled from parts so the text does not depend on the ICU version's punctuation.
  const dayParts = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: timezone,
  });
  const day = (value: Date) => {
    const part = (type: string) => dayParts.formatToParts(value).find((entry) => entry.type === type)?.value ?? "";
    return `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}`;
  };
  const time = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  return day(start) === day(end)
    ? `${day(start)}, ${time.format(start)} – ${time.format(end)}`
    : `${day(start)}, ${time.format(start)} – ${day(end)}, ${time.format(end)}`;
}

/** The first few non-empty lines of a body, quoted for a WhatsApp preview. */
export function previewLines(body: string, lines = 3, width = 120): string[] {
  const all = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const shown = all.slice(0, lines).map((line) => `> ${line.length > width ? `${line.slice(0, width - 1)}…` : line}`);
  if (all.length > lines) shown.push("> …");
  return shown;
}
