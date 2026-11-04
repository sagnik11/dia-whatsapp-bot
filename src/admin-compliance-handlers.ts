import { addComplianceSchema, listComplianceSchema, updateComplianceSchema } from "./admin-args.js";
import { daysBetween, type AdminContext, type AdminState } from "./admin-context.js";
import { COMPLIANCE_STATUSES, taskWindowOpensOn, type ComplianceRecord } from "./compliance-store.js";
import { addDays } from "./recurring-store.js";
import { final, output, type ToolOutcome } from "./tool-outcome.js";

function taskLanding(ctx: AdminContext, item: ComplianceRecord, today: string): string {
  const opens = taskWindowOpensOn(item);
  return opens <= today ? "task lands within the hour" : `task lands ${ctx.day(opens)}`;
}

export async function addCompliance(ctx: AdminContext, args: unknown, state: AdminState): Promise<ToolOutcome> {
  const parsed = addComplianceSchema.parse(args);
  const { compliance } = ctx.services;
  const results = await compliance.add(
    parsed.items.map((item) => ({
      name: item.name,
      authority: item.authority,
      area: item.area ?? null,
      dueOn: item.due_on,
      recurrence: item.recurrence ?? "none",
      owner: ctx.owner(item.owner, state),
      leadDays: item.lead_days ?? null,
      checklist: item.checklist,
      notes: item.notes,
    })),
    state.request.requestedBy,
  );
  const today = compliance.today();
  for (const { item } of results) state.knownCompliance.add(item.id);
  const added = results.filter((result) => !result.duplicate).length;
  const lines = results.map(({ item, duplicate }) =>
    duplicate
      ? `♻️ Already in the register: ${ctx.complianceLine(item)}`
      : `• ${ctx.complianceLine(item)} · ${taskLanding(ctx, item, today)}`,
  );
  return final(
    [
      `📋 Compliance register: ${added} added${added < results.length ? `, ${results.length - added} already there` : ""}.`,
      ...lines,
      "Tasks are added quietly ahead of each date; nothing is posted.",
    ].join("\n"),
  );
}

export async function listCompliance(ctx: AdminContext, args: unknown, state: AdminState): Promise<ToolOutcome> {
  const parsed = listComplianceSchema.parse(args);
  const { compliance } = ctx.services;
  const today = compliance.today();
  const status = parsed.status ?? "active";
  const active = status === "active";
  const items = await compliance.list({
    statuses: status === "all" ? [...COMPLIANCE_STATUSES] : [status],
    dueFrom: active && parsed.include_overdue === false ? today : null,
    dueTo: active ? addDays(today, parsed.within_days ?? 30) : null,
    owner: ctx.owner(parsed.owner, state),
    limit: 100,
  });
  for (const item of items) state.knownCompliance.add(item.id);
  return output({
    today,
    count: items.length,
    items: items.map((item) => {
      const daysLeft = daysBetween(today, item.dueOn);
      return {
        ref: `CO${item.id}`,
        name: item.name,
        authority: item.authority,
        area: item.area,
        due: ctx.day(item.dueOn),
        daysLeft,
        overdue: item.status === "active" && daysLeft < 0,
        recurrence: item.recurrence,
        owner: item.owner,
        leadDays: item.leadDays,
        task: item.taskId !== null && item.taskDueOn === item.dueOn ? `#${item.taskId}` : null,
        checklist: item.checklist,
        notes: item.notes,
        status: item.status,
        lastDone: item.lastDoneOn,
      };
    }),
    ...(items.length === 0
      ? { note: "Nothing matches. The register only holds what the founders or their CA added; do not suggest obligations." }
      : {}),
  });
}

export async function updateCompliance(ctx: AdminContext, args: unknown, state: AdminState): Promise<ToolOutcome> {
  const parsed = updateComplianceSchema.parse(args);
  const blocked = ctx.unknown(
    parsed.updates.map((update) => update.compliance_id),
    state.knownCompliance,
    "CO",
    "list_compliance",
  );
  if (blocked) return blocked;
  const { compliance } = ctx.services;
  const actor = state.request.requestedBy;
  const lines: string[] = [];
  for (const update of parsed.updates) {
    const id = update.compliance_id;
    if (update.action === "done") {
      lines.push(await markDone(ctx, id, state));
      continue;
    }
    if (update.action === "delete") {
      const removed = await compliance.remove(id, actor);
      const open =
        removed && removed.taskId !== null && removed.taskDueOn === removed.dueOn
          ? ` Its task #${removed.taskId} is left as is; delete it too if it no longer applies.`
          : "";
      lines.push(removed ? `🗑️ Deleted CO${id} ${removed.name}.${open}` : `⚠️ CO${id} was not found.`);
      continue;
    }
    const result = await compliance.update(
      id,
      {
        name: update.name,
        authority: update.authority,
        area: update.area ?? null,
        dueOn: update.due_on,
        recurrence: update.recurrence ?? null,
        owner: ctx.owner(update.owner, state),
        leadDays: update.lead_days ?? null,
        checklist: update.checklist,
        notes: update.notes,
        status: update.status ?? null,
      },
      actor,
    );
    if (!result) {
      lines.push(`⚠️ CO${id} was not found.`);
      continue;
    }
    const { before, after } = result;
    let moved = "";
    if (after.dueOn !== before.dueOn) {
      const taskId = await ctx.periodTask(before, { dueAt: after.dueOn }, actor);
      if (taskId !== null) {
        await compliance.markTaskCreated(after, taskId);
        moved = ` · task #${taskId} moved to ${ctx.day(after.dueOn)}`;
      }
    }
    const status = after.status === "archived" ? " · archived" : "";
    lines.push(`✏️ ${ctx.complianceLine(after)}${status}${moved}`);
  }
  return final(lines.join("\n"));
}

/** File this period: roll a recurring item forward (or archive a one-off) and close its task. */
async function markDone(ctx: AdminContext, id: number, state: AdminState): Promise<string> {
  if (state.doneCompliance.has(id)) return `⚠️ CO${id} was already marked done in this message; it moved forward once.`;
  const { compliance } = ctx.services;
  const actor = state.request.requestedBy;
  const result = await compliance.markDone(id, actor);
  if (!result) return `⚠️ CO${id} was not found.`;
  state.doneCompliance.add(id);
  const { before, after } = result;
  const closed = await ctx.periodTask(before, { status: "done" }, actor);
  const task = closed !== null ? ` Task #${closed} closed too.` : "";
  if (after.status === "archived") {
    return `✅ CO${id} ${after.name} done (one-off, archived).${task}`;
  }
  return `✅ CO${id} ${after.name} done for ${ctx.day(before.dueOn)}. Next due ${ctx.day(after.dueOn)}; ${taskLanding(ctx, after, compliance.today())}.${task}`;
}
