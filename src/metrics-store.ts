import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import { recordAudit, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";
import { isLocalDate, localDate } from "./recurring-store.js";

export interface MetricInput {
  name: string;
  value: number;
  unit: string | null;
  asOf: string;
  note: string | null;
}

export interface MetricRecord {
  id: number;
  name: string;
  value: number;
  unit: string | null;
  asOf: string;
  note: string | null;
  enteredBy: string;
  createdAt: string;
}

/** A metric's latest value against an earlier one. */
export interface MetricChange {
  name: string;
  unit: string | null;
  current: MetricRecord;
  previous: MetricRecord | null;
  absoluteChange: number | null;
  percentChange: number | null;
}

interface MetricRow {
  id: number;
  name: string;
  value: number;
  unit: string | null;
  as_of: string;
  note: string | null;
  entered_by: string;
  created_at: string;
}

const COLUMNS = "id, name, value, unit, as_of, note, entered_by, created_at";

function rowToMetric(row: MetricRow): MetricRecord {
  return {
    id: Number(row.id),
    name: row.name,
    value: Number(row.value),
    unit: row.unit,
    asOf: row.as_of,
    note: row.note,
    enteredBy: row.entered_by,
    createdAt: row.created_at,
  };
}

/** "  Monthly  MRR " → "monthly mrr", so the same KPI always lands in one series. */
export function normalizeMetricName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
}

export function changeBetween(
  from: number | null,
  to: number,
): { absoluteChange: number | null; percentChange: number | null } {
  if (from === null) return { absoluteChange: null, percentChange: null };
  const absoluteChange = Math.round((to - from) * 100) / 100;
  const percentChange = from === 0 ? null : Math.round(((to - from) / Math.abs(from)) * 1_000) / 10;
  return { absoluteChange, percentChange };
}

/** First and last local dates of a YYYY-MM month, plus the previous month's key. */
export function monthBounds(month: string): { first: string; last: string; previous: string } {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  const last = new Date(Date.UTC(year, index + 1, 0)).toISOString().slice(0, 10);
  const previous = new Date(Date.UTC(year, index - 1, 1)).toISOString().slice(0, 7);
  return { first: `${month}-01`, last, previous };
}

/** One point per date: a later entry for the same date is a correction and wins. */
function series(rows: readonly MetricRecord[]): MetricRecord[] {
  const byDate = new Map<string, MetricRecord>();
  for (const row of rows) {
    const existing = byDate.get(row.asOf);
    if (!existing || row.id > existing.id) byDate.set(row.asOf, row);
  }
  return [...byDate.values()].sort((a, b) => a.asOf.localeCompare(b.asOf));
}

function toChange(current: MetricRecord, previous: MetricRecord | null): MetricChange {
  return {
    name: current.name,
    unit: current.unit,
    current,
    previous,
    ...changeBetween(previous?.value ?? null, current.value),
  };
}

export class MetricValidationError extends Error {}

interface MetricStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  timezone: string;
  logger: Logger;
  now?: () => Date;
}

/** KPIs the founders state in chat, one row per value and date. */
export class MetricStore {
  public constructor(private readonly options: MetricStoreOptions) {}

  public today(): string {
    return localDate((this.options.now?.() ?? new Date()).getTime(), this.options.timezone);
  }

  public async log(
    entries: readonly MetricInput[],
    source: { actor: string; messageId: string | null },
  ): Promise<Array<{ metric: MetricRecord; duplicate: boolean }>> {
    await this.options.schema.ensure();
    const results: Array<{ metric: MetricRecord; duplicate: boolean }> = [];
    for (const entry of entries) {
      const name = normalizeMetricName(entry.name);
      if (!name) throw new MetricValidationError("Every metric needs a name");
      if (!Number.isFinite(entry.value)) throw new MetricValidationError(`${name} needs a numeric value`);
      if (!isLocalDate(entry.asOf)) {
        throw new MetricValidationError(`as_of "${entry.asOf}" for ${name} is not a YYYY-MM-DD date`);
      }
      const inserted = await this.options.db.query<MetricRow>(
        `INSERT INTO metrics (name, value, unit, as_of, note, entered_by, source_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_message_id, name, as_of) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          name,
          entry.value,
          entry.unit?.trim().slice(0, 20) || null,
          entry.asOf,
          entry.note?.trim().slice(0, 500) || null,
          source.actor,
          source.messageId,
          this.nowIso(),
        ],
      );
      const row = inserted.results[0];
      if (row) {
        const metric = rowToMetric(row);
        await recordAudit(
          this.options.db,
          this.options.logger,
          { entity: "metric", entityId: metric.id, action: "created", actor: source.actor, changes: metric },
          this.nowIso(),
        );
        results.push({ metric, duplicate: false });
        continue;
      }
      const existing = await this.options.db.query<MetricRow>(
        `SELECT ${COLUMNS} FROM metrics WHERE source_message_id = ? AND name = ? AND as_of = ?`,
        [source.messageId, name, entry.asOf],
      );
      if (!existing.results[0]) throw new Error(`Metric ${name} could not be persisted`);
      results.push({ metric: rowToMetric(existing.results[0]), duplicate: true });
    }
    return results;
  }

  /** One value per date between two local dates, oldest first. */
  public async series(name: string, from: string, to: string): Promise<MetricRecord[]> {
    return series(await this.rows([normalizeMetricName(name)], from, to));
  }

  /** Each metric's latest value against the value logged before it. */
  public async latest(names: readonly string[] | null): Promise<MetricChange[]> {
    const grouped = this.byName(await this.rows(names?.map(normalizeMetricName) ?? null, null, null));
    return [...grouped.values()].flatMap((points) => {
      const current = points.at(-1);
      return current ? [toChange(current, points.at(-2) ?? null)] : [];
    });
  }

  /** Metrics logged in a YYYY-MM month: the month's last value against the last one before it. */
  public async monthSummary(month: string): Promise<MetricChange[]> {
    const { first, last } = monthBounds(month);
    const grouped = this.byName(await this.rows(null, null, last));
    return [...grouped.values()].flatMap((points) => {
      const inMonth = points.filter((point) => point.asOf >= first);
      const current = inMonth.at(-1);
      if (!current) return [];
      return [toChange(current, points.filter((point) => point.asOf < first).at(-1) ?? null)];
    });
  }

  private byName(rows: readonly MetricRecord[]): Map<string, MetricRecord[]> {
    const grouped = new Map<string, MetricRecord[]>();
    for (const row of rows) grouped.set(row.name, [...(grouped.get(row.name) ?? []), row]);
    for (const [name, points] of grouped) grouped.set(name, series(points));
    return grouped;
  }

  private async rows(names: readonly string[] | null, from: string | null, to: string | null): Promise<MetricRecord[]> {
    await this.options.schema.ensure();
    const where = ["1 = 1"];
    const params: SqlValue[] = [];
    if (names?.length) {
      where.push(`name IN (${names.map(() => "?").join(", ")})`);
      params.push(...names);
    }
    if (from) {
      where.push("as_of >= ?");
      params.push(from);
    }
    if (to) {
      where.push("as_of <= ?");
      params.push(to);
    }
    const result = await this.options.db.query<MetricRow>(
      `SELECT ${COLUMNS} FROM metrics WHERE ${where.join(" AND ")} ORDER BY name, as_of, id LIMIT 5000`,
      params,
    );
    return result.results.map(rowToMetric);
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
