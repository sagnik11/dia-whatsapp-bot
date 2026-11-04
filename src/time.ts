export function zonedParts(value: Date, timezone: string): Record<string, number> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

export function localTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
  second = 0,
): number {
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timezone);
    const represented = Date.UTC(
      actual.year ?? year,
      (actual.month ?? month) - 1,
      actual.day ?? day,
      actual.hour ?? hour,
      actual.minute ?? minute,
      actual.second ?? second,
    );
    candidate += desired - represented;
  }
  return candidate;
}

export function nextDailyRunAt(
  nowMs: number,
  time: string,
  timezone: string,
): number {
  const [hourText, minuteText] = time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const nowParts = zonedParts(new Date(nowMs), timezone);
  const year = nowParts.year ?? 1970;
  const month = nowParts.month ?? 1;
  const day = nowParts.day ?? 1;
  let candidate = localTimeToUtc(year, month, day, hour, minute, timezone);
  if (candidate <= nowMs) {
    const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
    candidate = localTimeToUtc(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      hour,
      minute,
      timezone,
    );
  }
  return candidate;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * Convert a founder-supplied due value into a UTC timestamp.
 *
 * Date-only values resolve to the start or end of that calendar day in the
 * configured timezone. Datetimes without an offset are read as local time.
 * Returns null when the value cannot be interpreted.
 */
export function resolveDueTimestamp(
  value: string,
  timezone: string,
  boundary: "start" | "end" = "end",
): number | null {
  const trimmed = value.trim();
  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1, 4).map(Number) as [number, number, number];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return boundary === "start"
      ? localTimeToUtc(year, month, day, 0, 0, timezone)
      : localTimeToUtc(year, month, day, 23, 59, timezone, 59);
  }

  const local = LOCAL_DATETIME.exec(trimmed);
  if (local) {
    const [year, month, day, hour, minute, second] = local
      .slice(1, 7)
      .map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      return null;
    }
    return localTimeToUtc(year, month, day, hour, minute, timezone, second);
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatDueForDisplay(value: string, timezone: string): string {
  if (DATE_ONLY.test(value.trim())) {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(`${value.trim()}T00:00:00Z`));
  }
  const timestamp = resolveDueTimestamp(value, timezone);
  if (timestamp === null) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(timestamp));
}

/** Next occurrence of an ISO weekday (1 = Monday … 7 = Sunday) at HH:mm local time. */
export function nextWeeklyRunAt(
  nowMs: number,
  weekday: number,
  time: string,
  timezone: string,
): number {
  let candidate = nextDailyRunAt(nowMs, time, timezone);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const parts = zonedParts(new Date(candidate), timezone);
    const sundayZero = new Date(
      Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1),
    ).getUTCDay();
    if ((sundayZero === 0 ? 7 : sundayZero) === weekday) return candidate;
    candidate = nextDailyRunAt(candidate + 60_000, time, timezone);
  }
  return candidate;
}
