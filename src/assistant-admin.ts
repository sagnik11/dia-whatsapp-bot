import { createBoardItems, listBoard, updateBoardItems } from "./admin-board-handlers.js";
import { addCompliance, listCompliance, updateCompliance } from "./admin-compliance-handlers.js";
import { AdminContext, type AdminOptions, type AdminServices, type AdminState } from "./admin-context.js";
import { isAdminRequest, referencedAdminIds } from "./admin-detect.js";
import { draftInvestorUpdate } from "./admin-investor-handler.js";
import { latestMetrics, logMetrics, metricTrend } from "./admin-metric-handlers.js";
import { ADMIN_SCHEMA_STATEMENTS } from "./admin-schema.js";
import { ADMIN_INSTRUCTIONS, ADMIN_TOOLS } from "./admin-tools.js";
import { BoardValidationError } from "./board-store.js";
import { CandidateStore } from "./candidate-store.js";
import type { SqlExecutor } from "./cloudflare-d1.js";
import { ComplianceStore, ComplianceValidationError, createComplianceJob } from "./compliance-store.js";
import { SchemaGate } from "./d1-schema.js";
import { InvestorUpdateDrafter } from "./investor-update.js";
import type { LanguageModel } from "./llm.js";
import type { Logger } from "./logger.js";
import type { MemoryStore } from "./memory-store.js";
import { MetricStore, MetricValidationError } from "./metrics-store.js";
import { PipelineStore } from "./pipeline-store.js";
import type { TaskStore } from "./task-store.js";
import type { ScheduledJob, ToolModule, ToolSession } from "./tool-module.js";
import { output, type ToolOutcome } from "./tool-outcome.js";
import type { AssistantRequest } from "./types.js";

/** Phase 2 admin and ops: compliance register, metrics, pipelines, investor-update drafts. */
export class AdminTools implements ToolModule {
  public readonly name = "admin";
  public readonly tools = ADMIN_TOOLS;
  public readonly instructions = ADMIN_INSTRUCTIONS;
  private readonly context: AdminContext;

  public constructor(services: AdminServices, options: AdminOptions) {
    this.context = new AdminContext(services, options);
  }

  public detect(message: string): boolean {
    return isAdminRequest(message);
  }

  public begin(request: AssistantRequest, knownTaskIds: Set<number>): ToolSession {
    const referenced = referencedAdminIds([request.body, request.quotedMessage ?? ""].join("\n"));
    const state: AdminState = {
      request,
      knownTaskIds,
      knownCompliance: referenced.compliance,
      knownDeals: referenced.deals,
      knownCandidates: referenced.candidates,
      doneCompliance: new Set(),
    };
    return { handle: (name, args) => this.handle(name, args, state) };
  }

  /** Returns null when the tool belongs to another module. */
  public async handle(name: string, args: unknown, state: AdminState): Promise<ToolOutcome | null> {
    try {
      return await this.dispatch(name, args, state);
    } catch (error) {
      if (
        error instanceof ComplianceValidationError ||
        error instanceof MetricValidationError ||
        error instanceof BoardValidationError
      ) {
        return output({ error: `${error.message}. Nothing was saved; fix it and retry.` });
      }
      throw error;
    }
  }

  private dispatch(name: string, args: unknown, state: AdminState): Promise<ToolOutcome | null> {
    const ctx = this.context;
    switch (name) {
      case "add_compliance_items":
        return addCompliance(ctx, args, state);
      case "list_compliance":
        return listCompliance(ctx, args, state);
      case "update_compliance":
        return updateCompliance(ctx, args, state);
      case "log_metrics":
        return logMetrics(ctx, args, state);
      case "metric_trend":
        return metricTrend(ctx, args);
      case "latest_metrics":
        return latestMetrics(ctx, args);
      case "create_deals":
        return createBoardItems(ctx, "deal", args, state);
      case "list_pipeline":
        return listBoard(ctx, "deal", args, state);
      case "update_deals":
        return updateBoardItems(ctx, "deal", args, state);
      case "create_candidates":
        return createBoardItems(ctx, "candidate", args, state);
      case "list_candidates":
        return listBoard(ctx, "candidate", args, state);
      case "update_candidates":
        return updateBoardItems(ctx, "candidate", args, state);
      case "draft_investor_update":
        return draftInvestorUpdate(ctx, args, state);
      default:
        return Promise.resolve(null);
    }
  }
}

/** Wires the admin stores, module and silent compliance job for index.ts. */
export function createAdminOps(input: {
  db: SqlExecutor;
  tasks: TaskStore;
  memory?: Pick<MemoryStore, "search">;
  llm: LanguageModel;
  timezone: string;
  complianceLeadDays: number;
  pipelineStaleDays: number;
  logger: Logger;
}): { schema: SchemaGate; module: AdminTools; job: ScheduledJob } {
  const { db, timezone, logger } = input;
  const schema = new SchemaGate(db, ADMIN_SCHEMA_STATEMENTS, logger, "Admin and ops");
  const compliance = new ComplianceStore({ db, schema, timezone, logger, defaultLeadDays: input.complianceLeadDays });
  const module = new AdminTools(
    {
      compliance,
      metrics: new MetricStore({ db, schema, timezone, logger }),
      deals: new PipelineStore({ db, schema, timezone, logger }),
      candidates: new CandidateStore({ db, schema, timezone, logger }),
      tasks: input.tasks,
      drafter: new InvestorUpdateDrafter({ llm: input.llm, logger }),
      ...(input.memory ? { memory: input.memory } : {}),
    },
    { timezone, staleDays: input.pipelineStaleDays, logger },
  );
  return { schema, module, job: createComplianceJob({ compliance, tasks: input.tasks, timezone, logger }) };
}
