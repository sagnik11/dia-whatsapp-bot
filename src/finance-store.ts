import type { SqlExecutor, SqlValue } from "./cloudflare-d1.js";
import { escapeLike, recordAudit, type SchemaGate } from "./d1-schema.js";
import type { Logger } from "./logger.js";
import { addDays, isLocalDate, localDate } from "./recurring-store.js";
import type { SpendCategory } from "./types.js";

/** Keep in sync with migrations/0003_finance.sql (a test enforces this). */
export const FINANCE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor TEXT NOT NULL,
  plan TEXT,
  amount_inr REAL NOT NULL CHECK (amount_inr >= 0),
  cycle TEXT NOT NULL CHECK (cycle IN ('monthly', 'quarterly', 'yearly')),
  renews_on TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  notes TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  deleted_at TEXT
)`,
  "CREATE INDEX IF NOT EXISTS subscriptions_renewal ON subscriptions (deleted_at, status, renews_on)",
  `CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_inr REAL NOT NULL CHECK (amount_inr >= 0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (month, category)
)`,
  // Same as 0002_phase1.sql; repeated so finance audits work on their own.
  `CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
  "CREATE INDEX IF NOT EXISTS audit_events_entity ON audit_events (entity, entity_id, id)",
];

// --- Calendar helpers on local dates (YYYY-MM-DD) and months (YYYY-MM) -----------

export const SPEND_CATEGORIES = [
  "Travel",
  "Software & SaaS",
  "Hosting & Infrastructure",
  "Meals",
  "Marketing",
  "Contractors",
  "Office",
  "Legal & Finance",
  "Other",
] as const satisfies readonly SpendCategory[];
// Compile-time check that the list covers every spend-log category.
const allCategoriesListed: Exclude<SpendCategory, (typeof SPEND_CATEGORIES)[number]> extends never
  ? true
  : never = true;
void allCategoriesListed;

const MONTH = /^(\d{4})-(\d{2})$/;

export function isMonth(value: string): boolean {
  const match = MONTH.exec(value);
  return Boolean(match) && Number(match?.[2]) >= 1 && Number(match?.[2]) <= 12;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** First and last day of a YYYY-MM month. */
export function monthBounds(month: string): { from: string; to: string } {
  const match = MONTH.exec(month);
  if (!match || !isMonth(month)) throw new RangeError(`"${month}" is not a YYYY-MM month`);
  const year = Number(match[1]);
  const index = Number(match[2]);
  return { from: `${month}-01`, to: `${month}-${pad(daysInMonth(year, index))}` };
}

export function shiftMonth(month: string, delta: number): string {
  const match = MONTH.exec(month);
  if (!match) throw new RangeError(`"${month}" is not a YYYY-MM month`);
  const total = Number(match[1]) * 12 + Number(match[2]) - 1 + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** Adds calendar months, clamping the day to the target month's length. */
export function addMonths(date: string, months: number): string {
  if (!isLocalDate(date)) throw new RangeError(`"${date}" is not a YYYY-MM-DD date`);
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const total = year * 12 + month - 1 + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  return `${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, daysInMonth(targetYear, targetMonth)))}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

export function dateLabel(date: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function formatInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Rounds to paise so totals never drift from floating-point sums. */
export function roundInr(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// --- Subscriptions -----------------------------------------------------------------

export const SUBSCRIPTION_CYCLES = ["monthly", "quarterly", "yearly"] as const;
export type SubscriptionCycle = (typeof SUBSCRIPTION_CYCLES)[number];
export const SUBSCRIPTION_STATUSES = ["active", "cancelled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const CYCLE_MONTHS: Readonly<Record<SubscriptionCycle, number>> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

export function annualizedInr(amountInr: number, cycle: SubscriptionCycle): number {
  return roundInr(amountInr * (12 / CYCLE_MONTHS[cycle]));
}

/** The first renewal on or after `today`, stepping whole cycles from `renewsOn`. */
export function nextRenewalOnOrAfter(renewsOn: string, cycle: SubscriptionCycle, today: string): string {
  if (renewsOn >= today) return renewsOn;
  const step = CYCLE_MONTHS[cycle];
  // Step from the original date each time so a 31st does not drift to the 28th.
  for (let cycles = 1; cycles <= 1_200; cycles += 1) {
    const candidate = addMonths(renewsOn, cycles * step);
    if (candidate >= today) return candidate;
  }
  return today;
}

export interface SubscriptionInput {
  vendor: string;
  plan: string | null;
  amountInr: number;
  cycle: SubscriptionCycle;
  renewsOn: string | null;
  owner: string | null;
  notes: string | null;
}

export interface SubscriptionRecord {
  id: number;
  vendor: string;
  plan: string | null;
  amountInr: number;
  cycle: SubscriptionCycle;
  renewsOn: string | null;
  owner: string | null;
  status: SubscriptionStatus;
  notes: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export interface SubscriptionQuery {
  statuses: SubscriptionStatus[];
  /** Only subscriptions renewing between today and today + N days. */
  withinDays: number | null;
  owner: string | null;
  vendor: string | null;
  limit: number;
}

/** null leaves a field unchanged. */
export interface SubscriptionPatch {
  vendor: string | null;
  plan: string | null;
  amountInr: number | null;
  cycle: SubscriptionCycle | null;
  renewsOn: string | null;
  owner: string | null;
  notes: string | null;
  status: SubscriptionStatus | null;
  remove: boolean;
}

interface SubscriptionRow {
  id: number;
  vendor: string;
  plan: string | null;
  amount_inr: number;
  cycle: string;
  renews_on: string | null;
  owner: string | null;
  status: string;
  notes: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
}

const SUBSCRIPTION_COLUMNS =
  "id, vendor, plan, amount_inr, cycle, renews_on, owner, status, notes, created_by, updated_by, created_at, updated_at, cancelled_at";

function rowToSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: Number(row.id),
    vendor: row.vendor,
    plan: row.plan,
    amountInr: Number(row.amount_inr),
    cycle: row.cycle as SubscriptionCycle,
    renewsOn: row.renews_on,
    owner: row.owner,
    status: row.status as SubscriptionStatus,
    notes: row.notes,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
  };
}

export class FinanceValidationError extends Error {}

/** Patch's own actor name for automatic changes such as rolling renewals forward. */
export const SYSTEM_ACTOR = "Patch";

interface FinanceStoreOptions {
  db: SqlExecutor;
  schema: SchemaGate;
  timezone: string;
  logger: Logger;
  now?: () => Date;
}

/** SaaS and other recurring charges, with their next renewal date. */
export class SubscriptionStore {
  public constructor(private readonly options: FinanceStoreOptions) {}

  public today(): string {
    return localDate(this.nowMs(), this.options.timezone);
  }

  public async add(
    inputs: readonly SubscriptionInput[],
    actor: string,
  ): Promise<Array<{ subscription: SubscriptionRecord; duplicate: boolean }>> {
    await this.options.schema.ensure();
    const today = this.today();
    const results: Array<{ subscription: SubscriptionRecord; duplicate: boolean }> = [];
    for (const input of inputs) {
      const vendor = input.vendor.trim().slice(0, 120);
      if (!vendor) throw new FinanceValidationError("Every subscription needs a vendor");
      this.validateAmount(input.amountInr);
      const plan = input.plan?.trim().slice(0, 120) || null;
      const existing = await this.options.db.query<SubscriptionRow>(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
         WHERE deleted_at IS NULL AND status = 'active'
           AND lower(vendor) = lower(?) AND lower(coalesce(plan, '')) = lower(?)
         ORDER BY id LIMIT 1`,
        [vendor, plan ?? ""],
      );
      const found = existing.results[0];
      if (found) {
        results.push({ subscription: rowToSubscription(found), duplicate: true });
        continue;
      }
      const renewsOn = this.renewal(input.renewsOn, input.cycle, today);
      const now = this.nowIso();
      const inserted = await this.options.db.query<SubscriptionRow>(
        `INSERT INTO subscriptions (
           vendor, plan, amount_inr, cycle, renews_on, owner, notes,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${SUBSCRIPTION_COLUMNS}`,
        [
          vendor,
          plan,
          roundInr(input.amountInr),
          input.cycle,
          renewsOn,
          input.owner?.trim().slice(0, 100) || null,
          input.notes?.trim().slice(0, 1_000) || null,
          actor,
          actor,
          now,
          now,
        ],
      );
      const row = inserted.results[0];
      if (!row) throw new Error(`Subscription "${vendor}" could not be persisted`);
      const subscription = rowToSubscription(row);
      await this.audit(subscription.id, "created", actor, subscription);
      results.push({ subscription, duplicate: false });
    }
    return results;
  }

  /** Soonest renewal first; unknown renewal dates last. Rolls passed renewals forward first. */
  public async list(query: SubscriptionQuery): Promise<SubscriptionRecord[]> {
    await this.options.schema.ensure();
    await this.rollForwardPassed();
    const where = ["deleted_at IS NULL"];
    const params: SqlValue[] = [];
    const statuses = query.statuses.length ? query.statuses : ["active"];
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
    if (query.withinDays !== null) {
      const today = this.today();
      where.push("renews_on IS NOT NULL AND renews_on >= ? AND renews_on <= ?");
      params.push(today, addDays(today, query.withinDays));
    }
    if (query.owner?.trim()) {
      where.push("lower(owner) = lower(?)");
      params.push(query.owner.trim());
    }
    if (query.vendor?.trim()) {
      where.push("(vendor LIKE ? ESCAPE '\\' OR plan LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(query.vendor.trim())}%`;
      params.push(pattern, pattern);
    }
    const limit = Math.max(1, Math.min(Math.trunc(query.limit), 200));
    const result = await this.options.db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE ${where.join(" AND ")}
       ORDER BY CASE WHEN renews_on IS NULL THEN 1 ELSE 0 END, renews_on ASC, id ASC
       LIMIT ${limit}`,
      params,
    );
    return result.results.map(rowToSubscription);
  }

  /** Vendors of every active subscription, for skipping already-tracked candidates. */
  public async activeVendors(): Promise<string[]> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<{ vendor: string }>(
      "SELECT vendor FROM subscriptions WHERE deleted_at IS NULL AND status = 'active'",
    );
    return result.results.map((row) => row.vendor);
  }

  public async update(
    id: number,
    patch: SubscriptionPatch,
    actor: string,
  ): Promise<{ before: SubscriptionRecord; after: SubscriptionRecord; rolled: boolean } | null> {
    await this.options.schema.ensure();
    const current = await this.options.db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    const before = current.results[0] ? rowToSubscription(current.results[0]) : null;
    if (!before) return null;

    const now = this.nowIso();
    if (patch.remove) {
      await this.options.db.query(
        "UPDATE subscriptions SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        [now, actor, now, id],
      );
      await this.audit(id, "deleted", actor, before);
      return { before, after: before, rolled: false };
    }

    const assignments: string[] = [];
    const params: SqlValue[] = [];
    const set = (column: string, value: SqlValue) => {
      assignments.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.vendor?.trim() && patch.vendor.trim() !== before.vendor) set("vendor", patch.vendor.trim().slice(0, 120));
    if (patch.plan?.trim() && patch.plan.trim() !== before.plan) set("plan", patch.plan.trim().slice(0, 120));
    if (patch.amountInr !== null) {
      this.validateAmount(patch.amountInr);
      if (roundInr(patch.amountInr) !== before.amountInr) set("amount_inr", roundInr(patch.amountInr));
    }
    const cycle = patch.cycle ?? before.cycle;
    if (patch.cycle && patch.cycle !== before.cycle) set("cycle", patch.cycle);
    if (patch.owner?.trim() && patch.owner.trim() !== before.owner) set("owner", patch.owner.trim().slice(0, 100));
    if (patch.notes?.trim()) {
      set("notes", (before.notes ? `${before.notes}\n\n${patch.notes.trim()}` : patch.notes.trim()).slice(0, 2_000));
    }
    if (patch.status && patch.status !== before.status) {
      set("status", patch.status);
      set("cancelled_at", patch.status === "cancelled" ? now : null);
    }
    let rolled = false;
    const requested = patch.renewsOn?.trim() || null;
    const baseRenewal = requested ?? before.renewsOn;
    if (baseRenewal) {
      const next = this.renewal(baseRenewal, cycle, this.today());
      rolled = next !== baseRenewal;
      if (next !== before.renewsOn) set("renews_on", next);
    }
    if (assignments.length === 0) return { before, after: before, rolled: false };

    const updated = await this.options.db.query<SubscriptionRow>(
      `UPDATE subscriptions SET ${assignments.join(", ")}, updated_by = ?, updated_at = ?
       WHERE id = ? RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [...params, actor, now, id],
    );
    const row = updated.results[0];
    if (!row) return null;
    const after = rowToSubscription(row);
    await this.audit(id, "updated", actor, { before, after });
    return { before, after, rolled };
  }

  /** Moves every active renewal date that has passed to its next cycle. */
  public async rollForwardPassed(): Promise<number> {
    await this.options.schema.ensure();
    const today = this.today();
    const due = await this.options.db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
       WHERE deleted_at IS NULL AND status = 'active' AND renews_on IS NOT NULL AND renews_on < ?`,
      [today],
    );
    let rolled = 0;
    for (const row of due.results) {
      const before = rowToSubscription(row);
      if (!before.renewsOn) continue;
      const next = nextRenewalOnOrAfter(before.renewsOn, before.cycle, today);
      const now = this.nowIso();
      await this.options.db.query(
        "UPDATE subscriptions SET renews_on = ?, updated_by = ?, updated_at = ? WHERE id = ? AND renews_on = ?",
        [next, SYSTEM_ACTOR, now, before.id, before.renewsOn],
      );
      await this.audit(before.id, "renewal_rolled", SYSTEM_ACTOR, { from: before.renewsOn, to: next });
      rolled += 1;
    }
    return rolled;
  }

  private renewal(value: string | null, cycle: SubscriptionCycle, today: string): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (!isLocalDate(trimmed)) throw new FinanceValidationError(`"${trimmed}" is not a YYYY-MM-DD date`);
    return nextRenewalOnOrAfter(trimmed, cycle, today);
  }

  private validateAmount(amount: number): void {
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) {
      throw new FinanceValidationError(`${amount} is not a valid INR amount`);
    }
  }

  private audit(id: number, action: string, actor: string, changes: unknown): Promise<void> {
    return recordAudit(
      this.options.db,
      this.options.logger,
      { entity: "subscription", entityId: id, action, actor, changes },
      this.nowIso(),
    );
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }
}

// --- Budgets -----------------------------------------------------------------------

export interface BudgetRecord {
  id: number;
  month: string;
  category: SpendCategory;
  amountInr: number;
  updatedBy: string;
  updatedAt: string;
}

export interface BudgetEntry {
  month: string;
  category: SpendCategory;
  /** null removes the budget. */
  amountInr: number | null;
}

export type BudgetChange =
  | { action: "created" | "updated" | "unchanged"; budget: BudgetRecord; previousInr: number | null }
  | { action: "removed"; budget: BudgetRecord; previousInr: number }
  | { action: "missing"; month: string; category: SpendCategory };

interface BudgetRow {
  id: number;
  month: string;
  category: string;
  amount_inr: number;
  updated_by: string;
  updated_at: string;
  deleted_at: string | null;
}

const BUDGET_COLUMNS = "id, month, category, amount_inr, updated_by, updated_at, deleted_at";

function rowToBudget(row: BudgetRow): BudgetRecord {
  return {
    id: Number(row.id),
    month: row.month,
    category: row.category as SpendCategory,
    amountInr: Number(row.amount_inr),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** Monthly budget per spend-log category, one row per month and category. */
export class BudgetStore {
  public constructor(private readonly options: FinanceStoreOptions) {}

  public currentMonth(): string {
    return localDate((this.options.now?.() ?? new Date()).getTime(), this.options.timezone).slice(0, 7);
  }

  public async set(entries: readonly BudgetEntry[], actor: string): Promise<BudgetChange[]> {
    await this.options.schema.ensure();
    const changes: BudgetChange[] = [];
    for (const entry of entries) {
      if (!isMonth(entry.month)) throw new FinanceValidationError(`"${entry.month}" is not a YYYY-MM month`);
      if (entry.amountInr !== null && (!Number.isFinite(entry.amountInr) || entry.amountInr < 0 || entry.amountInr > 100_000_000)) {
        throw new FinanceValidationError(`${entry.amountInr} is not a valid INR amount`);
      }
      const existing = await this.options.db.query<BudgetRow>(
        `SELECT ${BUDGET_COLUMNS} FROM budgets WHERE month = ? AND category = ?`,
        [entry.month, entry.category],
      );
      const row = existing.results[0];
      const live = row && row.deleted_at === null ? rowToBudget(row) : null;
      const now = this.nowIso();

      if (entry.amountInr === null) {
        if (!row || !live) {
          changes.push({ action: "missing", month: entry.month, category: entry.category });
          continue;
        }
        await this.options.db.query(
          "UPDATE budgets SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?",
          [now, actor, now, row.id],
        );
        await this.audit(live.id, "deleted", actor, live);
        changes.push({ action: "removed", budget: live, previousInr: live.amountInr });
        continue;
      }

      const amount = roundInr(entry.amountInr);
      if (live && live.amountInr === amount) {
        changes.push({ action: "unchanged", budget: live, previousInr: live.amountInr });
        continue;
      }
      const written = row
        ? await this.options.db.query<BudgetRow>(
            `UPDATE budgets SET amount_inr = ?, deleted_at = NULL, updated_by = ?, updated_at = ?
             WHERE id = ? RETURNING ${BUDGET_COLUMNS}`,
            [amount, actor, now, row.id],
          )
        : await this.options.db.query<BudgetRow>(
            `INSERT INTO budgets (month, category, amount_inr, created_by, updated_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${BUDGET_COLUMNS}`,
            [entry.month, entry.category, amount, actor, actor, now, now],
          );
      const saved = written.results[0];
      if (!saved) throw new Error(`Budget ${entry.month} ${entry.category} could not be persisted`);
      const budget = rowToBudget(saved);
      const action = live ? "updated" : "created";
      await this.audit(budget.id, action, actor, { before: live, after: budget });
      changes.push({ action, budget, previousInr: live?.amountInr ?? null });
    }
    return changes;
  }

  public async forMonth(month: string): Promise<BudgetRecord[]> {
    await this.options.schema.ensure();
    const result = await this.options.db.query<BudgetRow>(
      `SELECT ${BUDGET_COLUMNS} FROM budgets WHERE month = ? AND deleted_at IS NULL ORDER BY category`,
      [month],
    );
    return result.results.map(rowToBudget);
  }

  private audit(id: number, action: string, actor: string, changes: unknown): Promise<void> {
    return recordAudit(
      this.options.db,
      this.options.logger,
      { entity: "budget", entityId: id, action, actor, changes },
      this.nowIso(),
    );
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}
