import { BoardStore, type BoardRecord, type BoardSpec, type BoardStoreOptions } from "./board-store.js";

export const DEAL_STAGES = ["lead", "qualified", "pilot", "negotiation", "won", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const PIPELINE_BOARD: BoardSpec = {
  table: "pipeline",
  entity: "deal",
  titleColumn: "company",
  detailColumn: "contact",
  nextColumn: "next_step",
  nextAtColumn: "next_step_at",
  stages: DEAL_STAGES,
  closedStages: ["won", "lost"],
  hasValue: true,
  dedupeOnDetail: false,
};

/** Leads, pilots and deals (P<id>), one row per company. */
export class PipelineStore extends BoardStore {
  public constructor(options: BoardStoreOptions) {
    super(PIPELINE_BOARD, options);
  }
}

/** A deal in the pipeline table's own words, for tools and drafts. */
export function dealView(record: BoardRecord) {
  return {
    ref: `P${record.id}`,
    id: record.id,
    company: record.title,
    contact: record.detail,
    stage: record.stage,
    valueInr: record.valueInr,
    nextStep: record.next,
    nextStepAt: record.nextAt,
    owner: record.owner,
    notes: record.notes,
    stageChangedAt: record.stageChangedAt,
  };
}
