import {
  createCandidatesSchema,
  createDealsSchema,
  listBoardSchema,
  updateCandidatesSchema,
  updateDealsSchema,
} from "./admin-args.js";
import type { AdminContext, AdminState } from "./admin-context.js";
import { boardFlags, type BoardClearable, type BoardInput, type BoardPatch, type BoardRecord, type BoardStore } from "./board-store.js";
import { CANDIDATE_STAGES, candidateView } from "./candidate-store.js";
import { formatValue } from "./indian-number.js";
import { DEAL_STAGES, dealView } from "./pipeline-store.js";
import { final, output, type ToolOutcome } from "./tool-outcome.js";

export type BoardKind = "deal" | "candidate";

interface Binding {
  store: BoardStore;
  prefix: "P" | "C";
  lister: string;
  stages: readonly [string, ...string[]];
  known: (state: AdminState) => Set<number>;
  view: (record: BoardRecord) => Record<string, unknown>;
}

function bind(ctx: AdminContext, kind: BoardKind): Binding {
  return kind === "deal"
    ? {
        store: ctx.services.deals,
        prefix: "P",
        lister: "list_pipeline",
        stages: DEAL_STAGES,
        known: (state) => state.knownDeals,
        view: dealView,
      }
    : {
        store: ctx.services.candidates,
        prefix: "C",
        lister: "list_candidates",
        stages: CANDIDATE_STAGES,
        known: (state) => state.knownCandidates,
        view: candidateView,
      };
}

const DEAL_CLEAR: Readonly<Record<string, BoardClearable>> = {
  contact: "detail",
  value_inr: "valueInr",
  next_step: "next",
  next_step_at: "nextAt",
  owner: "owner",
};
const CANDIDATE_CLEAR: Readonly<Record<string, BoardClearable>> = {
  role: "detail",
  next_action: "next",
  next_action_at: "nextAt",
  owner: "owner",
};

function clearFields(fields: readonly string[] | null | undefined, map: Readonly<Record<string, BoardClearable>>): BoardClearable[] {
  return (fields ?? []).flatMap((field) => (map[field] ? [map[field]] : []));
}

function createInputs(ctx: AdminContext, kind: BoardKind, args: unknown, state: AdminState): BoardInput[] {
  if (kind === "deal") {
    return createDealsSchema.parse(args).deals.map((deal) => ({
      title: deal.company,
      detail: deal.contact,
      stage: deal.stage ?? null,
      valueInr: deal.value_inr,
      next: deal.next_step,
      nextAt: deal.next_step_at,
      owner: ctx.owner(deal.owner, state),
      notes: deal.notes,
    }));
  }
  return createCandidatesSchema.parse(args).candidates.map((candidate) => ({
    title: candidate.name,
    detail: candidate.role,
    stage: candidate.stage ?? null,
    valueInr: null,
    next: candidate.next_action,
    nextAt: candidate.next_action_at,
    owner: ctx.owner(candidate.owner, state),
    notes: candidate.notes,
  }));
}

function updateInputs(
  ctx: AdminContext,
  kind: BoardKind,
  args: unknown,
  state: AdminState,
): Array<{ id: number; remove: boolean; patch: BoardPatch }> {
  if (kind === "deal") {
    return updateDealsSchema.parse(args).updates.map((update) => ({
      id: update.deal_id,
      remove: update.delete ?? false,
      patch: {
        title: update.company,
        detail: update.contact,
        stage: update.stage ?? null,
        valueInr: update.value_inr,
        next: update.next_step,
        nextAt: update.next_step_at,
        owner: ctx.owner(update.owner, state),
        notes: update.notes,
        clear: clearFields(update.clear, DEAL_CLEAR),
      },
    }));
  }
  return updateCandidatesSchema.parse(args).updates.map((update) => ({
    id: update.candidate_id,
    remove: update.delete ?? false,
    patch: {
      title: update.name,
      detail: update.role,
      stage: update.stage ?? null,
      valueInr: null,
      next: update.next_action,
      nextAt: update.next_action_at,
      owner: ctx.owner(update.owner, state),
      notes: update.notes,
      clear: clearFields(update.clear, CANDIDATE_CLEAR),
    },
  }));
}

export async function createBoardItems(
  ctx: AdminContext,
  kind: BoardKind,
  args: unknown,
  state: AdminState,
): Promise<ToolOutcome> {
  const board = bind(ctx, kind);
  const results = await board.store.create(createInputs(ctx, kind, args, state), state.request.requestedBy);
  for (const { record } of results) board.known(state).add(record.id);
  const heading = kind === "deal" ? "🤝 Pipeline" : "🧑‍💼 Hiring";
  const lines = results.map(({ record, duplicate }) =>
    `${duplicate ? "♻️ Already open:" : "•"} ${ctx.boardLine(board.prefix, record)}`,
  );
  return final([`${heading}: ${results.filter((result) => !result.duplicate).length} added.`, ...lines].join("\n"));
}

export async function listBoard(ctx: AdminContext, kind: BoardKind, args: unknown, state: AdminState): Promise<ToolOutcome> {
  const board = bind(ctx, kind);
  const { spec } = board.store;
  const parsed = listBoardSchema(board.stages).parse(args);
  const stage = parsed.stage ?? "open";
  const stages =
    stage === "all" ? null : stage === "open" ? spec.stages.filter((name) => !spec.closedStages.includes(name)) : [stage];
  const records = await board.store.list({ stages, owner: ctx.owner(parsed.owner, state), text: parsed.text, limit: parsed.limit ?? 50 });
  const nowMs = board.store.nowMs();
  const today = board.store.today();
  const staleDays = ctx.options.staleDays;
  const items = records
    .map((record) => {
      const flags = boardFlags(record, spec, nowMs, today, staleDays);
      const labels = [
        ...(flags.stuck ? [`stuck ${flags.daysInStage} days in ${record.stage}`] : []),
        ...(flags.noNextStep ? ["no next step"] : []),
        ...(flags.nextStepOverdue ? ["next step overdue"] : []),
      ];
      return { id: record.id, item: { ...board.view(record), daysInStage: flags.daysInStage, flags: labels } };
    })
    .filter(({ item }) => !parsed.flagged_only || item.flags.length > 0);
  for (const { id } of items) board.known(state).add(id);
  const byStage: Record<string, number> = {};
  for (const record of records) byStage[record.stage] = (byStage[record.stage] ?? 0) + 1;
  const openValue = records
    .filter((record) => !spec.closedStages.includes(record.stage))
    .reduce((total, record) => total + (record.valueInr ?? 0), 0);
  return output({
    today,
    stuckAfterDays: staleDays,
    count: items.length,
    byStage,
    ...(kind === "deal" ? { openValueInr: formatValue(openValue, "INR") } : {}),
    items: items.map(({ item }) => item),
  });
}

export async function updateBoardItems(
  ctx: AdminContext,
  kind: BoardKind,
  args: unknown,
  state: AdminState,
): Promise<ToolOutcome> {
  const board = bind(ctx, kind);
  const updates = updateInputs(ctx, kind, args, state);
  const blocked = ctx.unknown(
    updates.map((update) => update.id),
    board.known(state),
    board.prefix,
    board.lister,
  );
  if (blocked) return blocked;
  const actor = state.request.requestedBy;
  const lines: string[] = [];
  for (const { id, remove, patch } of updates) {
    if (remove) {
      const removed = await board.store.remove(id, actor);
      lines.push(removed ? `🗑️ Deleted ${board.prefix}${id} ${removed.title}.` : `⚠️ ${board.prefix}${id} was not found.`);
      continue;
    }
    const result = await board.store.update(id, patch, actor);
    if (!result) {
      lines.push(`⚠️ ${board.prefix}${id} was not found.`);
      continue;
    }
    const { before, after, changed } = result;
    if (changed.length === 0) {
      lines.push(`• ${ctx.boardLine(board.prefix, after)} — nothing to change`);
      continue;
    }
    const moved = after.stage !== before.stage ? ` (${before.stage} → ${after.stage})` : "";
    const icon = ["won", "hired"].includes(after.stage) && moved ? "🎉" : "✅";
    lines.push(`${icon} ${ctx.boardLine(board.prefix, after)}${moved}`);
  }
  return final(lines.join("\n"));
}
