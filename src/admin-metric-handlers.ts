import { latestMetricsSchema, logMetricsSchema, metricTrendSchema } from "./admin-args.js";
import type { AdminContext, AdminState } from "./admin-context.js";
import { formatValue, impliedUnit, isInr, parseIndianNumber } from "./indian-number.js";
import { changeBetween, normalizeMetricName, type MetricChange, type MetricInput } from "./metrics-store.js";
import { addDays } from "./recurring-store.js";
import { ToolArgumentError, final, output, type ToolOutcome } from "./tool-outcome.js";

function unitFor(unit: string | null, value: string | number): string | null {
  const given = unit ?? impliedUnit(value);
  return given && isInr(given) ? "INR" : given;
}

export async function logMetrics(ctx: AdminContext, args: unknown, state: AdminState): Promise<ToolOutcome> {
  const parsed = logMetricsSchema.parse(args);
  const { metrics } = ctx.services;
  const today = metrics.today();
  const unreadable: string[] = [];
  const entries: MetricInput[] = parsed.metrics.flatMap((metric, index) => {
    const value = parseIndianNumber(metric.value);
    if (value === null) {
      unreadable.push(`metrics.${index}.value "${metric.value}" is not a number Patch can read (try 1.2L, 2.5Cr, 40k)`);
      return [];
    }
    return [{ name: metric.name, value, unit: unitFor(metric.unit, metric.value), asOf: metric.as_of ?? today, note: metric.note }];
  });
  if (unreadable.length > 0) throw new ToolArgumentError(unreadable.join("; "));
  const results = await metrics.log(entries, { actor: state.request.requestedBy, messageId: state.request.messageId });
  const lines = results.map(
    ({ metric, duplicate }) =>
      `• ${metric.name}: ${formatValue(metric.value, metric.unit)} (as of ${ctx.day(metric.asOf)})${duplicate ? " — already logged" : ""}`,
  );
  return final([`📈 Logged ${results.length} metric${results.length === 1 ? "" : "s"}:`, ...lines].join("\n"));
}

function changeForModel(change: MetricChange) {
  return {
    name: change.name,
    unit: change.unit,
    value: change.current.value,
    display: formatValue(change.current.value, change.unit),
    asOf: change.current.asOf,
    previous: change.previous
      ? { value: change.previous.value, display: formatValue(change.previous.value, change.previous.unit), asOf: change.previous.asOf }
      : null,
    absoluteChange: change.absoluteChange,
    percentChange: change.percentChange,
  };
}

export async function metricTrend(ctx: AdminContext, args: unknown): Promise<ToolOutcome> {
  const parsed = metricTrendSchema.parse(args);
  const { metrics } = ctx.services;
  const until = parsed.until ?? metrics.today();
  const since = parsed.since ?? addDays(until, -180);
  const name = normalizeMetricName(parsed.name);
  const points = await metrics.series(name, since, until);
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) {
    return output({ name, since, until, points: [], note: "Nothing logged for this metric in that window. Say so; do not guess." });
  }
  return output({
    name,
    unit: last.unit,
    since,
    until,
    points: points.map((point) => ({ asOf: point.asOf, value: point.value, display: formatValue(point.value, point.unit), note: point.note })),
    first: { asOf: first.asOf, display: formatValue(first.value, first.unit) },
    latest: { asOf: last.asOf, display: formatValue(last.value, last.unit) },
    ...changeBetween(points.length > 1 ? first.value : null, last.value),
  });
}

export async function latestMetrics(ctx: AdminContext, args: unknown): Promise<ToolOutcome> {
  const parsed = latestMetricsSchema.parse(args);
  const changes = await ctx.services.metrics.latest(parsed.names ?? null);
  return output({
    metrics: changes.map(changeForModel),
    ...(changes.length === 0 ? { note: "No metrics logged yet. Say so; do not guess." } : {}),
  });
}
