import type { BoardRecord } from "./board-store.js";
import type { CandidateStore } from "./candidate-store.js";
import type { ComplianceRecord, ComplianceStore } from "./compliance-store.js";
import { formatValue } from "./indian-number.js";
import type { InvestorUpdateDrafter } from "./investor-update.js";
import type { Logger } from "./logger.js";
import type { MemoryStore } from "./memory-store.js";
import type { MetricStore } from "./metrics-store.js";
import type { PipelineStore } from "./pipeline-store.js";
import { isClosedStatus, type TaskPatch, type TaskStore } from "./task-store.js";
import { formatDueForDisplay } from "./time.js";
import { output, type ToolOutcome } from "./tool-outcome.js";
import type { AssistantRequest } from "./types.js";

export interface AdminServices {
  compliance: ComplianceStore;
  metrics: MetricStore;
  deals: PipelineStore;
  candidates: CandidateStore;
  tasks: TaskStore;
  drafter: InvestorUpdateDrafter;
  /** Decisions for the investor update; optional so the module works without Phase 1 memory. */
  memory?: Pick<MemoryStore, "search">;
}

export interface AdminOptions {
  timezone: string;
  /** Open deals and candidates in one stage this long are flagged stuck. */
  staleDays: number;
  logger: Logger;
}

export interface AdminState {
  request: AssistantRequest;
  knownTaskIds: Set<number>;
  knownCompliance: Set<number>;
  knownDeals: Set<number>;
  knownCandidates: Set<number>;
  /** Compliance ids already rolled forward in this request, so a repeated call cannot skip a period. */
  doneCompliance: Set<number>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Services plus the shared helpers every admin handler uses. */
export class AdminContext {
  public constructor(
    public readonly services: AdminServices,
    public readonly options: AdminOptions,
  ) {}

  public owner(value: string | null, state: AdminState): string | null {
    if (!value) return null;
    return /^(?:me|myself|i)$/i.test(value) ? state.request.requestedBy : value;
  }

  /** The Phase 1 id guard: only ids the founder named or a list call returned in this request. */
  public unknown(ids: readonly number[], known: Set<number>, prefix: string, lister: string): ToolOutcome | null {
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length === 0) return null;
    return output({
      error: `Nothing was changed. ${missing.map((id) => `${prefix}${id}`).join(", ")} was neither named by the founder nor returned by ${lister} in this request. Call ${lister} first.`,
    });
  }

  public day(date: string): string {
    return formatDueForDisplay(date, this.options.timezone);
  }

  public complianceLine(item: ComplianceRecord): string {
    const parts = [
      `CO${item.id} ${item.name}${item.authority ? ` (${item.authority})` : ""}`,
      `due ${this.day(item.dueOn)}`,
      item.recurrence === "none" ? "one-off" : item.recurrence,
      ...(item.owner ? [`owner ${item.owner}`] : []),
    ];
    return parts.join(" · ");
  }

  public boardLine(prefix: "P" | "C", record: BoardRecord): string {
    const detail = record.detail ? (prefix === "P" ? ` (${record.detail})` : ` — ${record.detail}`) : "";
    const parts = [
      `${prefix}${record.id} ${record.title}${detail}`,
      record.stage,
      ...(record.valueInr !== null ? [formatValue(record.valueInr, "INR")] : []),
      ...(record.next ? [`next: ${record.next}${record.nextAt ? ` by ${this.day(record.nextAt)}` : ""}`] : []),
      ...(record.owner ? [`owner ${record.owner}`] : []),
    ];
    return parts.join(" · ");
  }

  /** Close or re-date the task the silent job added for an item's current period. */
  public async periodTask(
    item: ComplianceRecord,
    patch: Partial<Pick<TaskPatch, "status" | "dueAt">>,
    actor: string,
  ): Promise<number | null> {
    if (item.taskId === null || item.taskDueOn !== item.dueOn) return null;
    const task = await this.services.tasks.get(item.taskId);
    if (!task || isClosedStatus(task.status)) return null;
    await this.services.tasks.update(
      task.id,
      {
        title: null,
        status: patch.status ?? null,
        priority: null,
        owner: null,
        area: null,
        dueAt: patch.dueAt ?? null,
        tags: null,
        notesMode: null,
        notes: null,
        clear: [],
      },
      actor,
    );
    return task.id;
  }
}
