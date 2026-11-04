import { investorUpdateSchema } from "./admin-args.js";
import type { AdminContext, AdminState } from "./admin-context.js";
import { CANDIDATE_BOARD } from "./candidate-store.js";
import { hasUpdateData, monthLabel, type InvestorUpdateInput } from "./investor-update.js";
import { monthBounds } from "./metrics-store.js";
import { PIPELINE_BOARD } from "./pipeline-store.js";
import { addDays } from "./recurring-store.js";
import { localTimeToUtc } from "./time.js";
import { ToolArgumentError, final, type ToolOutcome } from "./tool-outcome.js";

/** Start of a local date in the group's timezone, as a UTC ISO timestamp. */
function localStartIso(date: string, timezone: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(localTimeToUtc(year, month, day, 0, 0, timezone)).toISOString();
}

/** Everything stored about a month, gathered for the drafter. */
export async function gatherInvestorUpdate(
  ctx: AdminContext,
  month: string,
  groupId: string,
): Promise<InvestorUpdateInput> {
  const { tasks, metrics, deals, candidates, memory } = ctx.services;
  const { first, last } = monthBounds(month);
  const fromIso = localStartIso(first, ctx.options.timezone);
  const toIso = localStartIso(addDays(last, 1), ctx.options.timezone);
  const openDeals = PIPELINE_BOARD.stages.filter((stage) => !PIPELINE_BOARD.closedStages.includes(stage));
  const openCandidates = CANDIDATE_BOARD.stages.filter((stage) => !CANDIDATE_BOARD.closedStages.includes(stage));
  const [closed, metricChanges, decisions, dealsOpen, won, lost, candidatesOpen, hired] = await Promise.all([
    tasks.listClosedSince(fromIso, 200),
    metrics.monthSummary(month),
    memory
      ? memory.search(groupId, { text: null, kind: "decision", sinceIso: fromIso, limit: 100 })
      : Promise.resolve([]),
    deals.list({ stages: openDeals, owner: null, text: null, limit: 50 }),
    deals.movedInto(["won"], fromIso, toIso),
    deals.movedInto(["lost"], fromIso, toIso),
    candidates.list({ stages: openCandidates, owner: null, text: null, limit: 50 }),
    candidates.movedInto(["hired"], fromIso, toIso),
  ]);
  return {
    month,
    closedTasks: closed.filter((task) => task.status === "done" && task.completedAt !== null && task.completedAt < toIso),
    metrics: metricChanges,
    decisions: decisions.filter((memory) => memory.observedAt < toIso),
    deals: { open: dealsOpen, won, lost },
    candidates: { open: candidatesOpen, hired },
  };
}

export async function draftInvestorUpdate(ctx: AdminContext, args: unknown, state: AdminState): Promise<ToolOutcome> {
  const parsed = investorUpdateSchema.parse(args);
  const thisMonth = ctx.services.metrics.today().slice(0, 7);
  const month = parsed.month ?? monthBounds(thisMonth).previous;
  if (month > thisMonth) throw new ToolArgumentError(`month ${month} has not started yet`);
  const input = await gatherInvestorUpdate(ctx, month, state.request.groupId);
  const label = monthLabel(month);
  if (!hasUpdateData(input)) {
    return final(
      `📝 Nothing is stored for ${label}: no closed tasks, metrics, logged decisions, deals won or lost, or hires that month. Log some and ask again.`,
    );
  }
  const draft = await ctx.services.drafter.draft(input);
  return final(
    `📝 *DRAFT* investor update for ${label}. Not sent anywhere; check every line before you send it yourselves.\n\n${draft}`,
  );
}
