import { BoardStore, type BoardRecord, type BoardSpec, type BoardStoreOptions } from "./board-store.js";

export const CANDIDATE_STAGES = ["sourced", "screen", "interview", "offer", "hired", "rejected"] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

export const CANDIDATE_BOARD: BoardSpec = {
  table: "candidates",
  entity: "candidate",
  titleColumn: "name",
  detailColumn: "role",
  nextColumn: "next_action",
  nextAtColumn: "next_action_at",
  stages: CANDIDATE_STAGES,
  closedStages: ["hired", "rejected"],
  hasValue: false,
  dedupeOnDetail: true,
};

/** The hiring pipeline (C<id>), one row per person and role. */
export class CandidateStore extends BoardStore {
  public constructor(options: BoardStoreOptions) {
    super(CANDIDATE_BOARD, options);
  }
}

/** A candidate in the candidates table's own words, for tools and drafts. */
export function candidateView(record: BoardRecord) {
  return {
    ref: `C${record.id}`,
    id: record.id,
    name: record.title,
    role: record.detail,
    stage: record.stage,
    nextAction: record.next,
    nextActionAt: record.nextAt,
    owner: record.owner,
    notes: record.notes,
    stageChangedAt: record.stageChangedAt,
  };
}
