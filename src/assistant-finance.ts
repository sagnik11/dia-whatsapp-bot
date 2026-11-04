import { z } from "zod";
import {
  SPEND_GROUP_BYS,
  budgetStatus,
  detectRecurringCharges,
  formatBudgetStatus,
  formatCandidates,
  formatRollup,
  formatSettlement,
  settleReimbursements,
  summarizeSpends,
  type DateWindow,
} from "./finance-report.js";
import {
  FinanceValidationError,
  SPEND_CATEGORIES,
  SUBSCRIPTION_CYCLES,
  SUBSCRIPTION_STATUSES,
  addMonths,
  annualizedInr,
  dateLabel,
  daysBetween,
  formatInr,
  isMonth,
  monthBounds,
  monthLabel,
  roundInr,
  shiftMonth,
  type BudgetChange,
  type BudgetStore,
  type SubscriptionCycle,
  type SubscriptionRecord,
  type SubscriptionStore,
} from "./finance-store.js";
import type { ToolDefinition } from "./llm.js";
import type { Logger } from "./logger.js";
import type { AllSpendsResult, SpendRange } from "./notion-spend.js";
import { addDays } from "./recurring-store.js";
import type { ToolModule, ToolSession } from "./tool-module.js";
import { ToolArgumentError, final, output, type ToolOutcome } from "./tool-outcome.js";
import type { AssistantRequest } from "./types.js";

export interface FinanceServices {
  subscriptions: SubscriptionStore;
  budgets: BudgetStore;
  /** The Notion Daily Spend Log; receipts, roll-ups, settlement and detection need it. */
  spendLog?: { listAllSpends(range: SpendRange): Promise<AllSpendsResult> };
}

export interface FinanceOptions {
  /** Payment methods that spend company money, so they are never owed back (lower-cased). */
  companyPaymentMethods: readonly string[];
  logger: Logger;
}

interface FinanceState {
  request: AssistantRequest;
  knownSubscriptionIds: Set<number>;
}

// --- Detection and id references ------------------------------------------------

export function isReceiptRequest(message: string): boolean {
  return (
    /\b(?:add|log|record|capture|save|put|enter|expense)\b[\s\S]{0,60}\b(?:receipts?|bills?|invoices?)\b/i.test(message) ||
    /\b(?:receipts?|bills?|invoices?)\b[\s\S]{0,60}\b(?:add|log|record|capture|save|enter)\b/i.test(message)
  );
}

export function isSpendRollupRequest(message: string): boolean {
  return (
    /\broll[\s-]?up\b|\bmonth[\s-]+over[\s-]+month\b|\b(?:spend(?:ing)?|expenses?|monthly)\s+(?:summary|breakdown|report)\b/i.test(message) ||
    /\b(?:breakdown|split|grouped?)\b[\s\S]{0,40}\bby\s+(?:category|categories|vendors?|founders?|payers?|payment)\b/i.test(message)
  );
}

export function isReimbursementRequest(message: string): boolean {
  return /\breimburs\w*|\bwho\s+owes\s+whom\b|\bsettle(?:ment|\s+up)\b|\bowe[sd]?\s+(?:me|sagnik|tanvi|her|him)\b/i.test(message);
}

export function isSubscriptionRequest(message: string): boolean {
  return /\bsubscriptions?\b|\brenew(?:s|al|als|ing)?\b|\btrack\s+(?:all\b|#?\d)/i.test(message);
}

export function isBudgetRequest(message: string): boolean {
  return /\bbudget(?:s|ed|ing)?\b/i.test(message);
}

/** Subscription ids a founder referenced as S12, "subscription 4" or "subscriptions 3 and 5". */
export function referencedSubscriptionIds(text: string): Set<number> {
  const cleaned = text.replace(/\b(?:aws|amazon)\s+s3\b/gi, " ");
  const ids = new Set<number>();
  for (const match of cleaned.matchAll(/\bS(\d{1,9})\b/g)) ids.add(Number(match[1]));
  for (const match of cleaned.matchAll(/\bsubscriptions?\s*(?:#|S)?((?:\d{1,9}(?:\s*(?:,|&|\band\b)\s*)?)+)/gi)) {
    for (const id of (match[1] ?? "").matchAll(/\d{1,9}/g)) ids.add(Number(id[0]));
  }
  return ids;
}

// --- Schemas ------------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || null);

const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : value);

const inrAmount = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/₹|rs\.?|inr|,|\s/gi, "") : value),
  z.coerce.number().nonnegative().max(100_000_000),
);

const monthSchema = z
  .string()
  .trim()
  .refine(isMonth, "must be a YYYY-MM month")
  .nullish()
  .transform((value) => value ?? null);

const dateSchema = z.iso
  .date()
  .nullish()
  .transform((value) => value ?? null);

const cycleSchema = z.preprocess((value) => {
  const text = lower(value);
  if (typeof text !== "string") return text;
  if (/^(?:year|yearly|annual|annually|per year)$/.test(text)) return "yearly";
  if (/^(?:quarter|quarterly)$/.test(text)) return "quarterly";
  if (/^(?:month|monthly|per month)$/.test(text)) return "monthly";
  return text;
}, z.enum(SUBSCRIPTION_CYCLES));

const CATEGORY_ALIASES: ReadonlyArray<[RegExp, (typeof SPEND_CATEGORIES)[number]]> = [
  [/saas|software|tools?/, "Software & SaaS"],
  [/hosting|infra|cloud|server/, "Hosting & Infrastructure"],
  [/meal|food|chai|coffee/, "Meals"],
  [/legal|finance|\bca\b|accounting/, "Legal & Finance"],
  [/contractor|freelanc/, "Contractors"],
  [/travel|cab|flight/, "Travel"],
  [/marketing|ads?\b/, "Marketing"],
  [/office|rent/, "Office"],
];

const categorySchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const text = value.trim().toLowerCase();
  const exact = SPEND_CATEGORIES.find((category) => category.toLowerCase() === text);
  if (exact) return exact;
  return CATEGORY_ALIASES.find(([pattern]) => pattern.test(text))?.[1] ?? value;
}, z.enum(SPEND_CATEGORIES));

const periodShape = { month: monthSchema, date_from: dateSchema, date_to: dateSchema };

const spendSummarySchema = z.object({
  ...periodShape,
  group_by: z.preprocess(lower, z.enum(SPEND_GROUP_BYS).nullish()),
});

const settlementSchema = z.object({ ...periodShape, founder: optionalText(100) });

const addSubscriptionsSchema = z.object({
  subscriptions: z
    .array(
      z.object({
        vendor: z.string().trim().min(1).max(120),
        plan: optionalText(120),
        amount_inr: inrAmount,
        cycle: cycleSchema,
        renews_on: dateSchema,
        owner: optionalText(100),
        notes: optionalText(1_000),
      }),
    )
    .min(1)
    .max(20),
});

const listSubscriptionsSchema = z.object({
  within_days: z.coerce.number().int().min(0).max(366).nullish(),
  status: z.preprocess(lower, z.enum([...SUBSCRIPTION_STATUSES, "all"]).nullish()),
  owner: optionalText(100),
  vendor: optionalText(120),
  limit: z.coerce.number().int().min(1).max(100).nullish(),
});

const updateSubscriptionSchema = z.object({
  subscription_id: z.coerce.number().int().positive(),
  vendor: optionalText(120),
  plan: optionalText(120),
  amount_inr: inrAmount.nullish(),
  cycle: cycleSchema.nullish(),
  renews_on: dateSchema,
  owner: optionalText(100),
  notes: optionalText(1_000),
  status: z.preprocess(lower, z.enum(SUBSCRIPTION_STATUSES).nullish()),
  delete: z.boolean().nullish(),
});

const setBudgetsSchema = z.object({
  budgets: z
    .array(
      z.object({
        month: monthSchema,
        category: categorySchema,
        amount_inr: inrAmount.nullish(),
        remove: z.boolean().nullish(),
      }),
    )
    .min(1)
    .max(30),
});

const budgetStatusSchema = z.object({ month: monthSchema });

// --- Tool definitions -----------------------------------------------------------

const periodProperties = {
  month: { type: "string", description: "Calendar month as YYYY-MM. Default: this month to date." },
  date_from: { type: "string", description: "Inclusive YYYY-MM-DD, instead of month." },
  date_to: { type: "string", description: "Inclusive YYYY-MM-DD, instead of month. Default today." },
};

const SPEND_LOG_TOOLS: readonly ToolDefinition[] = [
  {
    name: "spend_summary",
    description:
      "Monthly (or date-range) spend roll-up from the whole Daily Spend Log: total, entry count and change versus the previous period, grouped by category, founder, vendor or payment method. The founder sees the computed answer directly.",
    parameters: {
      type: "object",
      properties: {
        ...periodProperties,
        group_by: { type: "string", enum: [...SPEND_GROUP_BYS], description: "Default category." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "reimbursement_settlement",
    description:
      "What the company owes each founder for a month or range: spends marked Reimbursable and paid personally, with per-founder totals and line items ('who owes whom for October?').",
    parameters: {
      type: "object",
      properties: {
        ...periodProperties,
        founder: { type: "string", description: "Only this founder; omit for both." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "detect_subscriptions",
    description:
      "Scan the last 6 months of the spend log for vendors charged repeatedly at similar amounts and show them as numbered candidates. Adds nothing; the founder confirms first.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

const SUBSCRIPTION_AND_BUDGET_TOOLS: readonly ToolDefinition[] = [
  {
    name: "add_subscriptions",
    description:
      "Track recurring charges (SaaS, hosting, retainers) on the subscription radar. Use when a founder asks to track one, or confirms candidates from detect_subscriptions.",
    parameters: {
      type: "object",
      properties: {
        subscriptions: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              vendor: { type: "string", description: "Who charges it, e.g. Notion, AWS." },
              plan: { type: "string", description: "Plan or seat count, if known." },
              amount_inr: { type: "number", description: "INR charged per cycle, as a number." },
              cycle: { type: "string", enum: [...SUBSCRIPTION_CYCLES] },
              renews_on: { type: "string", description: "Next renewal date, YYYY-MM-DD, if known." },
              owner: { type: "string", description: "Founder responsible; 'me' means the sender." },
              notes: { type: "string" },
            },
            required: ["vendor", "amount_inr", "cycle"],
            additionalProperties: false,
          },
        },
      },
      required: ["subscriptions"],
      additionalProperties: false,
    },
  },
  {
    name: "list_subscriptions",
    description:
      "Subscription radar (S<id>): tracked subscriptions soonest renewal first, with the annualized cost total. Pass within_days for 'what renews in the next N days' or 'this month' (days left in the month).",
    parameters: {
      type: "object",
      properties: {
        within_days: { type: "integer", minimum: 0, maximum: 366 },
        status: { type: "string", enum: [...SUBSCRIPTION_STATUSES, "all"], description: "Default active." },
        owner: { type: "string" },
        vendor: { type: "string", description: "Part of the vendor or plan name." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 50." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_subscription",
    description:
      "Change one subscription by S<id>: new amount, cycle, renewal date, plan, owner or notes; status cancelled to cancel (active to restore); delete=true only to remove a mistaken entry. Use an id the founder named or list_subscriptions returned in this request.",
    parameters: {
      type: "object",
      properties: {
        subscription_id: { type: "integer", minimum: 1 },
        vendor: { type: "string" },
        plan: { type: "string" },
        amount_inr: { type: "number" },
        cycle: { type: "string", enum: [...SUBSCRIPTION_CYCLES] },
        renews_on: { type: "string", description: "YYYY-MM-DD." },
        owner: { type: "string" },
        notes: { type: "string", description: "Appended to existing notes." },
        status: { type: "string", enum: [...SUBSCRIPTION_STATUSES] },
        delete: { type: "boolean" },
      },
      required: ["subscription_id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_budgets",
    description:
      "Set, change or remove monthly budgets per spend-log category, several at once ('₹20k travel and ₹40k SaaS for November').",
    parameters: {
      type: "object",
      properties: {
        budgets: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              month: { type: "string", description: "YYYY-MM. Default this month." },
              category: { type: "string", enum: [...SPEND_CATEGORIES] },
              amount_inr: { type: "number" },
              remove: { type: "boolean", description: "True to delete this month's budget for the category." },
            },
            required: ["category"],
            additionalProperties: false,
          },
        },
      },
      required: ["budgets"],
      additionalProperties: false,
    },
  },
  {
    name: "budget_status",
    description:
      "Actual spend versus budget per category for one month, with percent used and how much is left or over. The founder sees the computed answer directly.",
    parameters: {
      type: "object",
      properties: { month: { type: "string", description: "YYYY-MM. Default this month." } },
      additionalProperties: false,
    },
  },
];

const SPEND_LOG_INSTRUCTIONS: readonly string[] = [
  "- Receipts: when a founder sends a photo or PDF of a bill, receipt or invoice (in this message or the one it quotes) and asks to log it, read the vendor, the bill date, the final amount paid in INR (after tax and discounts) and the closest category, then call add_spends with one expense per bill. paid_by is the sender unless they name someone. Use the printed bill date, not today. Put the invoice number and GST amount in notes when visible. Set payment_method only when the bill or the founder states it, and reimbursable only when the founder says so. If the bill is in another currency, or the total or date is unreadable, ask instead of guessing; never convert currencies yourself.",
  "- spend_summary gives roll-ups by category, founder, vendor or payment method with the change versus the previous period; reimbursement_settlement says what the company owes each founder. Both reply to the founder directly, so never recompute or restate their numbers.",
  "- detect_subscriptions lists repeating charges from the last 6 months as numbered candidates. Add nothing until a founder confirms. When they reply 'track 1 and 3' or 'track all' (usually quoting that list), call add_subscriptions with exactly those candidates' vendor, amount, cycle, and next date as renews_on.",
];

const CORE_INSTRUCTIONS: readonly string[] = [
  "- Subscriptions (S<id>): add_subscriptions, list_subscriptions (renewal radar with annualized cost) and update_subscription for an S<id> the founder named or list_subscriptions returned in this request. To cancel or change one described in words, call list_subscriptions with its vendor first. When the founder only asked to see subscriptions, reply with list_subscriptions' formatted text unchanged.",
  "- Budgets: set_budgets saves monthly budgets per spend-log category (months are YYYY-MM, default this month); budget_status compares actual spend with them and replies directly.",
  "- Patch gives no tax, investment or accounting advice; it only organizes the founders' own numbers.",
];

const NO_SPEND_LOG_INSTRUCTION =
  "- The Daily Spend Log is not configured, so bill photos, roll-ups, reimbursements and subscription detection are unavailable; budget_status shows budgets without actual spend.";

// --- Formatting ---------------------------------------------------------------------

const CYCLE_UNIT: Readonly<Record<SubscriptionCycle, string>> = {
  monthly: "month",
  quarterly: "quarter",
  yearly: "year",
};

function subscriptionHead(subscription: SubscriptionRecord): string {
  const plan = subscription.plan ? ` (${subscription.plan})` : "";
  return `S${subscription.id} ${subscription.vendor}${plan} — ${formatInr(subscription.amountInr)}/${CYCLE_UNIT[subscription.cycle]}`;
}

function subscriptionLine(subscription: SubscriptionRecord, today: string | null = null): string {
  let renewal = " · renewal date unknown";
  if (subscription.status === "cancelled") {
    renewal = " · cancelled";
  } else if (subscription.renewsOn) {
    const days = today ? daysBetween(today, subscription.renewsOn) : null;
    const when = days === null ? "" : days === 0 ? " (today)" : days === 1 ? " (tomorrow)" : ` (in ${days} days)`;
    renewal = ` · renews ${dateLabel(subscription.renewsOn)}${when}`;
  }
  const owner = subscription.owner ? ` · owner ${subscription.owner}` : "";
  return `${subscriptionHead(subscription)}${renewal}${owner}`;
}

const earlier = (a: string, b: string) => (a < b ? a : b);

function shortRange(from: string, to: string): string {
  const format = (date: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-IN", { ...options, timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  if (from === to) return dateLabel(from);
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return `${Number(from.slice(8))}–${dateLabel(to)}`;
  }
  if (from.slice(0, 4) === to.slice(0, 4)) {
    return `${format(from, { day: "numeric", month: "short" })} – ${dateLabel(to)}`;
  }
  return `${dateLabel(from)} – ${dateLabel(to)}`;
}

function budgetChangeLine(change: BudgetChange): string {
  if (change.action === "missing") {
    return `• ${monthLabel(change.month)} · ${change.category}: no budget to remove`;
  }
  const where = `${monthLabel(change.budget.month)} · ${change.budget.category}`;
  switch (change.action) {
    case "removed":
      return `• ${where}: removed (was ${formatInr(change.previousInr)})`;
    case "created":
      return `• ${where}: ${formatInr(change.budget.amountInr)} (new)`;
    case "updated":
      return `• ${where}: ${formatInr(change.budget.amountInr)} (was ${formatInr(change.previousInr ?? 0)})`;
    case "unchanged":
      return `• ${where}: ${formatInr(change.budget.amountInr)} (unchanged)`;
  }
}

// --- Module -------------------------------------------------------------------------

/** Phase 2 money: receipts, roll-ups, reimbursements, subscription radar and budgets. */
export class FinanceTools implements ToolModule {
  public readonly name = "finance";
  public readonly tools: readonly ToolDefinition[];
  public readonly instructions: readonly string[];
  private readonly companyMethods: ReadonlySet<string>;

  public constructor(
    private readonly services: FinanceServices,
    private readonly options: FinanceOptions,
  ) {
    const spendLog = Boolean(services.spendLog);
    this.tools = [...(spendLog ? SPEND_LOG_TOOLS : []), ...SUBSCRIPTION_AND_BUDGET_TOOLS];
    this.instructions = [
      "Money (receipts, roll-ups, reimbursements, subscriptions, budgets):",
      ...(spendLog ? SPEND_LOG_INSTRUCTIONS : [NO_SPEND_LOG_INSTRUCTION]),
      ...CORE_INSTRUCTIONS,
    ];
    this.companyMethods = new Set(options.companyPaymentMethods.map((method) => method.trim().toLowerCase()));
  }

  public detect(message: string): boolean {
    return (
      isSubscriptionRequest(message) ||
      isBudgetRequest(message) ||
      (Boolean(this.services.spendLog) &&
        (isReceiptRequest(message) || isSpendRollupRequest(message) || isReimbursementRequest(message)))
    );
  }

  public begin(request: AssistantRequest): ToolSession {
    const state: FinanceState = {
      request,
      knownSubscriptionIds: referencedSubscriptionIds([request.body, request.quotedMessage ?? ""].join("\n")),
    };
    return { handle: (name, args) => this.handle(name, args, state) };
  }

  public async handle(name: string, args: unknown, state: FinanceState): Promise<ToolOutcome | null> {
    try {
      switch (name) {
        case "spend_summary":
          return await this.spendSummary(args);
        case "reimbursement_settlement":
          return await this.settlement(args);
        case "detect_subscriptions":
          return await this.detectSubscriptions();
        case "add_subscriptions":
          return await this.addSubscriptions(args, state);
        case "list_subscriptions":
          return await this.listSubscriptions(args, state);
        case "update_subscription":
          return await this.updateSubscription(args, state);
        case "set_budgets":
          return await this.setBudgets(args, state);
        case "budget_status":
          return await this.budgetStatus(args);
        default:
          return null;
      }
    } catch (error) {
      if (error instanceof FinanceValidationError) return output({ error: `${error.message}. Fix it and retry.` });
      throw error;
    }
  }

  private today(): string {
    return this.services.subscriptions.today();
  }

  private owner(value: string | null, state: FinanceState): string | null {
    if (!value) return null;
    return /^(?:me|myself|i)$/i.test(value) ? state.request.requestedBy : value;
  }

  /** The requested window (never past today) and the window it is compared with. */
  private period(parsed: { month: string | null; date_from: string | null; date_to: string | null }): {
    current: DateWindow;
    previous: DateWindow;
  } {
    const today = this.today();
    let month = parsed.month;
    if (!month && parsed.date_from && parsed.date_to) {
      const bounds = monthBounds(parsed.date_from.slice(0, 7));
      if (parsed.date_from === bounds.from && parsed.date_to === bounds.to) month = parsed.date_from.slice(0, 7);
    }
    if (month || (!parsed.date_from && !parsed.date_to)) {
      const target = month ?? today.slice(0, 7);
      const bounds = monthBounds(target);
      if (bounds.from > today) throw new ToolArgumentError(`${target} has not started yet`);
      const previousBounds = monthBounds(shiftMonth(target, -1));
      if (bounds.to <= today) {
        return {
          current: { ...bounds, label: monthLabel(target) },
          previous: { ...previousBounds, label: monthLabel(shiftMonth(target, -1)) },
        };
      }
      const elapsed = daysBetween(bounds.from, today);
      const previousTo = earlier(addDays(previousBounds.from, elapsed), previousBounds.to);
      return {
        current: { from: bounds.from, to: today, label: `${monthLabel(target)} to date` },
        previous: { from: previousBounds.from, to: previousTo, label: shortRange(previousBounds.from, previousTo) },
      };
    }
    const to = earlier(parsed.date_to ?? today, today);
    const from = parsed.date_from ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw new ToolArgumentError(`date_from ${from} is after date_to ${to} (dates past today are ignored)`);
    const length = daysBetween(from, to);
    if (length > 366) throw new ToolArgumentError("the range can cover at most one year");
    const previousTo = addDays(from, -1);
    const previousFrom = addDays(previousTo, -length);
    return {
      current: { from, to, label: shortRange(from, to) },
      previous: { from: previousFrom, to: previousTo, label: shortRange(previousFrom, previousTo) },
    };
  }

  private async readSpends(range: SpendRange): Promise<AllSpendsResult | ToolOutcome> {
    if (!this.services.spendLog) return output({ error: "The Daily Spend Log is not configured." });
    try {
      return await this.services.spendLog.listAllSpends(range);
    } catch (error) {
      this.options.logger.warn({ error }, "Finance spend-log read failed");
      return output({
        error: "The Daily Spend Log could not be read. Tell the founder briefly; do not invent numbers.",
      });
    }
  }

  private async spendSummary(args: unknown): Promise<ToolOutcome> {
    const parsed = spendSummarySchema.parse(args);
    const { current, previous } = this.period(parsed);
    const read = await this.readSpends({ dateFrom: previous.from, dateTo: current.to });
    if ("kind" in read) return read;
    const rollup = summarizeSpends(read.spends, current, previous, parsed.group_by ?? "category");
    return final(formatRollup(rollup, read.truncated));
  }

  private async settlement(args: unknown): Promise<ToolOutcome> {
    const parsed = settlementSchema.parse(args);
    const { current } = this.period(parsed);
    const read = await this.readSpends({ dateFrom: current.from, dateTo: current.to });
    if ("kind" in read) return read;
    const settlement = settleReimbursements(read.spends, current, this.companyMethods, parsed.founder);
    return final(formatSettlement(settlement, read.truncated));
  }

  private async detectSubscriptions(): Promise<ToolOutcome> {
    const today = this.today();
    const since = addMonths(today, -6);
    const read = await this.readSpends({ dateFrom: since, dateTo: today });
    if ("kind" in read) return read;
    const tracked = await this.services.subscriptions.activeVendors();
    return final(formatCandidates(detectRecurringCharges(read.spends, today, tracked), since));
  }

  private async addSubscriptions(args: unknown, state: FinanceState): Promise<ToolOutcome> {
    const parsed = addSubscriptionsSchema.parse(args);
    const results = await this.services.subscriptions.add(
      parsed.subscriptions.map((item) => ({
        vendor: item.vendor,
        plan: item.plan,
        amountInr: item.amount_inr,
        cycle: item.cycle,
        renewsOn: item.renews_on,
        owner: this.owner(item.owner, state),
        notes: item.notes,
      })),
      state.request.requestedBy,
    );
    for (const { subscription } of results) state.knownSubscriptionIds.add(subscription.id);
    const today = this.today();
    const lines = results.map(({ subscription, duplicate }) =>
      `${duplicate ? "♻️ already tracked:" : "•"} ${subscriptionLine(subscription, today)}`,
    );
    return final(
      [`📦 Tracking ${results.length} subscription${results.length === 1 ? "" : "s"}:`, ...lines].join("\n"),
    );
  }

  private async listSubscriptions(args: unknown, state: FinanceState): Promise<ToolOutcome> {
    const parsed = listSubscriptionsSchema.parse(args);
    const status = parsed.status ?? "active";
    const withinDays = parsed.within_days ?? null;
    const subscriptions = await this.services.subscriptions.list({
      statuses: status === "all" ? [...SUBSCRIPTION_STATUSES] : [status],
      withinDays,
      owner: this.owner(parsed.owner, state),
      vendor: parsed.vendor,
      limit: parsed.limit ?? 50,
    });
    for (const subscription of subscriptions) state.knownSubscriptionIds.add(subscription.id);
    const today = this.today();
    const active = subscriptions.filter((subscription) => subscription.status === "active");
    const annualPaise = active.reduce(
      (sum, subscription) => sum + Math.round(annualizedInr(subscription.amountInr, subscription.cycle) * 100),
      0,
    );
    const annualized = annualPaise / 100;
    const kind = status === "all" ? "" : `${status} `;
    const renewingBy = withinDays === null ? "" : ` renewing by ${dateLabel(addDays(today, withinDays))}`;
    const plural = subscriptions.length === 1 ? "" : "s";
    const formatted =
      subscriptions.length === 0
        ? `📦 No ${kind}subscriptions${renewingBy}.`
        : [
            `📦 ${subscriptions.length} ${kind}subscription${plural}${renewingBy}:`,
            ...subscriptions.map((subscription) => `• ${subscriptionLine(subscription, today)}`),
            ...(active.length > 0
              ? [`Annualized: ${formatInr(annualized)} (≈ ${formatInr(roundInr(annualized / 12))}/month)`]
              : []),
          ].join("\n");
    return output({
      count: subscriptions.length,
      annualizedTotalInr: annualized,
      subscriptions: subscriptions.map((subscription) => ({
        ref: `S${subscription.id}`,
        id: subscription.id,
        vendor: subscription.vendor,
        plan: subscription.plan,
        amountInr: subscription.amountInr,
        cycle: subscription.cycle,
        renewsOn: subscription.renewsOn,
        daysToRenewal: subscription.renewsOn ? daysBetween(today, subscription.renewsOn) : null,
        owner: subscription.owner,
        status: subscription.status,
        notes: subscription.notes,
        annualizedInr: annualizedInr(subscription.amountInr, subscription.cycle),
      })),
      formatted,
    });
  }

  private async updateSubscription(args: unknown, state: FinanceState): Promise<ToolOutcome> {
    const parsed = updateSubscriptionSchema.parse(args);
    const id = parsed.subscription_id;
    if (!state.knownSubscriptionIds.has(id)) {
      return output({
        error: `Nothing was changed. S${id} was neither named by the founder nor returned by list_subscriptions in this request. Call list_subscriptions first.`,
      });
    }
    const result = await this.services.subscriptions.update(
      id,
      {
        vendor: parsed.vendor,
        plan: parsed.plan,
        amountInr: parsed.amount_inr ?? null,
        cycle: parsed.cycle ?? null,
        renewsOn: parsed.renews_on,
        owner: this.owner(parsed.owner, state),
        notes: parsed.notes,
        status: parsed.status ?? null,
        remove: parsed.delete ?? false,
      },
      state.request.requestedBy,
    );
    if (!result) return final(`⚠️ S${id} was not found.`);
    const { before, after, rolled } = result;
    if (parsed.delete) return final(`🗑️ Removed S${id} ${before.vendor} from the subscription list.`);
    if (after.status === "cancelled" && before.status !== "cancelled") {
      return final(`🛑 Cancelled ${subscriptionHead(after)}. It is off the renewal radar.`);
    }
    const changes: string[] = [];
    if (before.amountInr !== after.amountInr) changes.push(`amount ${formatInr(before.amountInr)} → ${formatInr(after.amountInr)}`);
    if (before.cycle !== after.cycle) changes.push(`cycle ${before.cycle} → ${after.cycle}`);
    if (before.renewsOn !== after.renewsOn && after.renewsOn) {
      changes.push(
        rolled
          ? `renewal rolled forward to ${dateLabel(after.renewsOn)}`
          : `renewal ${before.renewsOn ? `${dateLabel(before.renewsOn)} → ` : ""}${dateLabel(after.renewsOn)}`,
      );
    }
    if (before.status !== after.status) changes.push(`${after.status} again`);
    if (before.vendor !== after.vendor) changes.push(`vendor ${before.vendor} → ${after.vendor}`);
    if (before.plan !== after.plan) changes.push(`plan ${after.plan}`);
    if (before.owner !== after.owner) changes.push(`owner ${after.owner}`);
    if (before.notes !== after.notes) changes.push("notes added");
    if (changes.length === 0) return final(`Nothing to change on ${subscriptionLine(after, this.today())}.`);
    return final(`✅ ${subscriptionLine(after, this.today())}\nChanged: ${changes.join("; ")}.`);
  }

  private async setBudgets(args: unknown, state: FinanceState): Promise<ToolOutcome> {
    const parsed = setBudgetsSchema.parse(args);
    const currentMonth = this.services.budgets.currentMonth();
    const entries = parsed.budgets.map((item, index) => {
      if (!item.remove && (item.amount_inr === null || item.amount_inr === undefined)) {
        throw new ToolArgumentError(`budgets.${index}.amount_inr is required unless remove is true`);
      }
      return {
        month: item.month ?? currentMonth,
        category: item.category,
        amountInr: item.remove ? null : (item.amount_inr ?? null),
      };
    });
    const changes = await this.services.budgets.set(entries, state.request.requestedBy);
    return final(["🎯 Budgets saved:", ...changes.map(budgetChangeLine)].join("\n"));
  }

  private async budgetStatus(args: unknown): Promise<ToolOutcome> {
    const parsed = budgetStatusSchema.parse(args);
    const month = parsed.month ?? this.services.budgets.currentMonth();
    const budgets = await this.services.budgets.forMonth(month);
    let spends: AllSpendsResult = { spends: [], truncated: false };
    if (this.services.spendLog) {
      const bounds = monthBounds(month);
      const read = await this.readSpends({ dateFrom: bounds.from, dateTo: bounds.to });
      if ("kind" in read) return read;
      spends = read;
    }
    return final(
      formatBudgetStatus(budgetStatus(month, budgets, spends.spends), {
        today: this.today(),
        spendLogAvailable: Boolean(this.services.spendLog),
        truncated: spends.truncated,
      }),
    );
  }
}
