import type { SqlExecutor } from "./cloudflare-d1.js";
import { recordAudit, type SchemaGate } from "./d1-schema.js";
import { REF_PREFIX, type OutboundKind } from "./go-ahead.js";
import type { Logger } from "./logger.js";

export const OUTBOUND_STATUSES = ["drafted", "sent", "proposed", "booked", "cancelled"] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

/** Keep in sync with migrations/0005_integrations.sql (a test enforces this). */
export const INTEGRATIONS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS outbound_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'calendar')),
  status TEXT NOT NULL
    CHECK (status IN ('drafted', 'sent', 'proposed', 'booked', 'cancelled')),
  group_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  external_id TEXT,
  created_by TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  executed_by TEXT,
  executed_at TEXT,
  updated_at TEXT NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS outbound_actions_lookup ON outbound_actions (group_id, kind, status, id)",
];

export interface OutboundAction {
  id: number;
  ref: string;
  kind: OutboundKind;
  status: OutboundStatus;
  groupId: string;
  summary: string;
  payload: Record<string, unknown>;
  externalId: string | null;
  createdBy: string;
  sourceMessageId: string | null;
  createdAt: string;
  executedBy: string | null;
  executedAt: string | null;
}

interface OutboundRow {
  id: number;
  kind: string;
  status: string;
  group_id: string;
  summary: string;
  payload: string;
  external_id: string | null;
  created_by: string;
  source_message_id: string | null;
  created_at: string;
  executed_by: string | null;
  executed_at: string | null;
}

const COLUMNS =
  "id, kind, status, group_id, summary, payload, external_id, created_by, source_message_id, created_at, executed_by, executed_at";

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToAction(row: OutboundRow): OutboundAction {
  const kind = row.kind as OutboundKind;
  return {
    id: Number(row.id),
    ref: `${REF_PREFIX[kind]}${Number(row.id)}`,
    kind,
    status: row.status as OutboundStatus,
    groupId: row.group_id,
    summary: row.summary,
    payload: parsePayload(row.payload),
    externalId: row.external_id,
    createdBy: row.created_by,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    executedBy: row.executed_by,
    executedAt: row.executed_at,
  };
}

export interface OutboundCreateInput {
  kind: OutboundKind;
  status: "drafted" | "proposed";
  groupId: string;
  summary: string;
  payload: Record<string, unknown>;
  externalId: string | null;
  createdBy: string;
  sourceMessageId: string | null;
}

interface OutboundStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  logger: Logger;
  now?: () => Date;
}

/** A claim older than this is treated as abandoned (the process died mid-send). */
const STALE_CLAIM_MS = 5 * 60_000;

/**
 * The outbound actions ledger: every Gmail draft (E<id>) and calendar
 * proposal (EV<id>), and who sent or booked it. Rows never cross groups.
 */
export class OutboundStore {
  public constructor(private readonly options: OutboundStoreOptions) {}

  public async create(input: OutboundCreateInput): Promise<OutboundAction> {
    await this.options.schema.ensure();
    const now = this.nowIso();
    const result = await this.options.db.query<OutboundRow>(
      `INSERT INTO outbound_actions (
         kind, status, group_id, summary, payload, external_id, created_by,
         source_message_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
      [
        input.kind,
        input.status,
        input.groupId,
        input.summary.trim().slice(0, 300),
        JSON.stringify(input.payload),
        input.externalId,
        input.createdBy,
        input.sourceMessageId,
        now,
        now,
      ],
    );
    const row = result.results[0];
    if (!row) throw new Error("The outbound action could not be recorded");
    const action = rowToAction(row);
    await this.audit(action.id, "created", input.createdBy, { status: action.status, summary: action.summary });
    return action;
  }

  public async get(groupId: string, kind: OutboundKind, id: number): Promise<OutboundAction | null> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<OutboundRow>(
      `SELECT ${COLUMNS} FROM outbound_actions WHERE id = ? AND kind = ? AND group_id = ?`,
      [id, kind, groupId],
    );
    const row = result.results[0];
    return row ? rowToAction(row) : null;
  }

  /**
   * Atomically reserves a drafted/proposed row for execution so two messages
   * cannot send or book it twice. Returns null when it is not in that status
   * or another request holds a fresh claim.
   */
  public async claim(
    groupId: string,
    kind: OutboundKind,
    id: number,
    from: "drafted" | "proposed",
    actor: string,
  ): Promise<OutboundAction | null> {
    await this.options.schema.ensure();
    const now = this.now();
    const result = await this.options.db.query<OutboundRow>(
      `UPDATE outbound_actions SET executed_by = ?, executed_at = ?, updated_at = ?
       WHERE id = ? AND kind = ? AND group_id = ? AND status = ?
         AND (executed_at IS NULL OR executed_at < ?)
       RETURNING ${COLUMNS}`,
      [actor, now.toISOString(), now.toISOString(), id, kind, groupId, from, new Date(now.getTime() - STALE_CLAIM_MS).toISOString()],
    );
    const row = result.results[0];
    return row ? rowToAction(row) : null;
  }

  /** Gives a claim back after the external call failed, so a founder can retry. */
  public async release(id: number): Promise<void> {
    await this.options.db.query(
      "UPDATE outbound_actions SET executed_by = NULL, executed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('drafted', 'proposed')",
      [this.nowIso(), id],
    );
  }

  /** Marks a claimed row sent or booked, keeping the external id and result. */
  public async complete(
    id: number,
    status: "sent" | "booked",
    actor: string,
    externalId: string,
    result: Record<string, unknown>,
  ): Promise<OutboundAction> {
    const now = this.nowIso();
    const updated = await this.options.db.query<OutboundRow>(
      `UPDATE outbound_actions
       SET status = ?, external_id = ?, executed_by = ?, executed_at = ?, updated_at = ?,
           payload = json_set(payload, '$.result', json(?))
       WHERE id = ? RETURNING ${COLUMNS}`,
      [status, externalId, actor, now, now, JSON.stringify(result), id],
    );
    const row = updated.results[0];
    if (!row) throw new Error(`Outbound action ${id} disappeared while it was being executed`);
    const action = rowToAction(row);
    await this.audit(id, status, actor, { externalId, result });
    return action;
  }

  private audit(id: number, action: string, actor: string, changes: unknown): Promise<void> {
    return recordAudit(
      this.options.db,
      this.options.logger,
      { entity: "outbound_action", entityId: id, action, actor, changes },
      this.nowIso(),
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}
