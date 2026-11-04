import {
  CYCLE_MONTHS,
  addMonths,
  annualizedInr,
  dateLabel,
  daysBetween,
  formatInr,
  monthBounds,
  monthLabel,
  nextRenewalOnOrAfter,
  type BudgetRecord,
} from "./finance-store.js";
import type { SpendSummary } from "./types.js";

// Every total here is summed in whole paise so the same rows always give the
// same rupee figures, whatever order Notion returns them in.

export const SPEND_GROUP_BYS = ["category", "founder", "vendor", "payment_method"] as const;
export type SpendGroupBy = (typeof SPEND_GROUP_BYS)[number];

export interface DateWindow {
  from: string;
  to: string;
  label: string;
}

const paise = (amount: number) => Math.round(amount * 100);
const rupees = (value: number) => value / 100;

function spendDate(spend: SpendSummary): string | null {
  return spend.date ? spend.date.slice(0, 10) : null;
}

function inWindow(spend: SpendSummary, window: { from: string; to: string }): boolean {
  const date = spendDate(spend);
  return date !== null && date >= window.from && date <= window.to;
}

function payerLabel(spend: SpendSummary): string {
  return spend.paidBy.length ? spend.paidBy.join(" & ") : "Unknown payer";
}

function vendorKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function changePercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function changeLabel(current: number, previous: number): string {
  const percent = changePercent(current, previous);
  if (percent === null) return current === 0 ? "—" : "new";
  return percent > 0 ? `+${percent}%` : percent < 0 ? `−${Math.abs(percent)}%` : "±0%";
}

// --- Roll-up -------------------------------------------------------------------------

export interface SpendGroup {
  label: string;
  totalInr: number;
  count: number;
  previousInr: number;
  previousCount: number;
  changePct: number | null;
}

export interface SpendRollup {
  groupBy: SpendGroupBy;
  current: DateWindow;
  previous: DateWindow;
  totalInr: number;
  count: number;
  previousInr: number;
  previousCount: number;
  changePct: number | null;
  groups: SpendGroup[];
}

function groupKey(spend: SpendSummary, groupBy: SpendGroupBy): { key: string; label: string } {
  switch (groupBy) {
    case "category": {
      const label = spend.category ?? "Uncategorized";
      return { key: label.toLowerCase(), label };
    }
    case "founder": {
      const label = payerLabel(spend);
      return { key: label.toLowerCase(), label };
    }
    case "vendor": {
      const label = spend.vendor?.trim() || "(no vendor)";
      return { key: vendorKey(label) || label, label };
    }
    case "payment_method": {
      const label = spend.paymentMethod ?? "Not recorded";
      return { key: label.toLowerCase(), label };
    }
  }
}

export function summarizeSpends(
  spends: readonly SpendSummary[],
  current: DateWindow,
  previous: DateWindow,
  groupBy: SpendGroupBy,
): SpendRollup {
  const groups = new Map<string, { label: string; now: number; count: number; before: number; beforeCount: number }>();
  let total = 0;
  let count = 0;
  let previousTotal = 0;
  let previousCount = 0;
  for (const spend of spends) {
    const isCurrent = inWindow(spend, current);
    const isPrevious = !isCurrent && inWindow(spend, previous);
    if (!isCurrent && !isPrevious) continue;
    const { key, label } = groupKey(spend, groupBy);
    const group = groups.get(key) ?? { label, now: 0, count: 0, before: 0, beforeCount: 0 };
    const amount = paise(spend.amount);
    if (isCurrent) {
      group.now += amount;
      group.count += 1;
      group.label = label; // the current period's spelling wins
      total += amount;
      count += 1;
    } else {
      group.before += amount;
      group.beforeCount += 1;
      previousTotal += amount;
      previousCount += 1;
    }
    groups.set(key, group);
  }
  return {
    groupBy,
    current,
    previous,
    totalInr: rupees(total),
    count,
    previousInr: rupees(previousTotal),
    previousCount,
    changePct: changePercent(total, previousTotal),
    groups: [...groups.values()]
      .map((group) => ({
        label: group.label,
        totalInr: rupees(group.now),
        count: group.count,
        previousInr: rupees(group.before),
        previousCount: group.beforeCount,
        changePct: changePercent(group.now, group.before),
      }))
      .sort((a, b) => b.totalInr - a.totalInr || b.previousInr - a.previousInr || a.label.localeCompare(b.label)),
  };
}

const GROUP_BY_LABEL: Readonly<Record<SpendGroupBy, string>> = {
  category: "category",
  founder: "founder",
  vendor: "vendor",
  payment_method: "payment method",
};

const MAX_ROLLUP_GROUPS = 12;

export function formatRollup(rollup: SpendRollup, truncated: boolean): string {
  const header = `📊 Spend · ${rollup.current.label} · by ${GROUP_BY_LABEL[rollup.groupBy]}`;
  if (rollup.count === 0 && rollup.previousCount === 0) {
    return `${header}\nNo spend-log entries in ${rollup.current.label} or ${rollup.previous.label}.`;
  }
  const lines = [
    header,
    `Total ${formatInr(rollup.totalInr)} · ${rollup.count} entr${rollup.count === 1 ? "y" : "ies"} · vs ${rollup.previous.label}: ${formatInr(rollup.previousInr)} (${changeLabel(rollup.totalInr, rollup.previousInr)})`,
  ];
  const shown = rollup.groups.slice(0, MAX_ROLLUP_GROUPS);
  for (const group of shown) {
    const was = group.count === 0 ? ` · was ${formatInr(group.previousInr)}` : "";
    lines.push(
      `• ${group.label}: ${formatInr(group.totalInr)} (${group.count})${was} · ${changeLabel(group.totalInr, group.previousInr)}`,
    );
  }
  const rest = rollup.groups.slice(MAX_ROLLUP_GROUPS);
  if (rest.length > 0) {
    const restTotal = rest.reduce((sum, group) => sum + paise(group.totalInr), 0);
    lines.push(`• ${rest.length} more: ${formatInr(rupees(restTotal))}`);
  }
  if (truncated) {
    lines.push("⚠️ Partial: the spend log returned more rows than Patch reads at once; these totals cover the first 5,000.");
  }
  return lines.join("\n");
}

// --- Reimbursement settlement -------------------------------------------------------

export interface SettlementLine {
  date: string;
  spend: string;
  amountInr: number;
  paymentMethod: string | null;
}

export interface FounderSettlement {
  founder: string;
  totalInr: number;
  lines: SettlementLine[];
}

export interface Settlement {
  window: DateWindow;
  founders: FounderSettlement[];
  totalInr: number;
  companyPaid: { count: number; totalInr: number };
}

/**
 * What the company owes each founder: entries marked Reimbursable that were not
 * paid with a company payment method. A missing method counts as personal.
 */
export function settleReimbursements(
  spends: readonly SpendSummary[],
  window: DateWindow,
  companyPaymentMethods: ReadonlySet<string>,
  founderFilter: string | null = null,
): Settlement {
  const founders = new Map<string, { founder: string; total: number; lines: SettlementLine[] }>();
  let total = 0;
  let companyCount = 0;
  let companyTotal = 0;
  const filter = founderFilter?.trim().toLowerCase() || null;
  for (const spend of spends) {
    if (!spend.reimbursable || !inWindow(spend, window)) continue;
    const founder = payerLabel(spend);
    if (filter && !founder.toLowerCase().includes(filter)) continue;
    const amount = paise(spend.amount);
    if (spend.paymentMethod && companyPaymentMethods.has(spend.paymentMethod.trim().toLowerCase())) {
      companyCount += 1;
      companyTotal += amount;
      continue;
    }
    const entry = founders.get(founder.toLowerCase()) ?? { founder, total: 0, lines: [] };
    entry.total += amount;
    entry.lines.push({
      date: spendDate(spend) ?? window.from,
      spend: spend.spend,
      amountInr: rupees(amount),
      paymentMethod: spend.paymentMethod,
    });
    founders.set(founder.toLowerCase(), entry);
    total += amount;
  }
  return {
    window,
    founders: [...founders.values()]
      .map((entry) => ({
        founder: entry.founder,
        totalInr: rupees(entry.total),
        lines: entry.lines.sort((a, b) => a.date.localeCompare(b.date) || a.spend.localeCompare(b.spend)),
      }))
      .sort((a, b) => b.totalInr - a.totalInr || a.founder.localeCompare(b.founder)),
    totalInr: rupees(total),
    companyPaid: { count: companyCount, totalInr: rupees(companyTotal) },
  };
}

const MAX_SETTLEMENT_LINES = 8;

function shortDate(date: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

export function formatSettlement(settlement: Settlement, truncated: boolean): string {
  const header = `💸 Reimbursements · ${settlement.window.label}`;
  const lines: string[] = [header];
  if (settlement.founders.length === 0) {
    lines.push("Nothing to settle: no entries marked Reimbursable and paid personally.");
  }
  for (const founder of settlement.founders) {
    lines.push(
      `Company owes ${founder.founder} ${formatInr(founder.totalInr)} (${founder.lines.length} entr${founder.lines.length === 1 ? "y" : "ies"}):`,
    );
    for (const line of founder.lines.slice(0, MAX_SETTLEMENT_LINES)) {
      lines.push(
        `  • ${shortDate(line.date)} · ${line.spend} · ${formatInr(line.amountInr)}${line.paymentMethod ? ` · ${line.paymentMethod}` : ""}`,
      );
    }
    const rest = founder.lines.slice(MAX_SETTLEMENT_LINES);
    if (rest.length > 0) {
      const restTotal = rest.reduce((sum, line) => sum + paise(line.amountInr), 0);
      lines.push(`  … and ${rest.length} more (${formatInr(rupees(restTotal))})`);
    }
  }
  if (settlement.founders.length > 1) {
    lines.push(`Total to reimburse: ${formatInr(settlement.totalInr)}`);
  }
  if (settlement.companyPaid.count > 0) {
    lines.push(
      `ℹ️ Left out ${settlement.companyPaid.count} reimbursable entr${settlement.companyPaid.count === 1 ? "y" : "ies"} paid with a company method (${formatInr(settlement.companyPaid.totalInr)}).`,
    );
  }
  if (truncated) {
    lines.push("⚠️ Partial: the spend log returned more rows than Patch reads at once.");
  }
  return lines.join("\n");
}

// --- Subscription detection ---------------------------------------------------------

export interface RecurringCandidate {
  vendor: string;
  amountInr: number;
  cycle: "monthly" | "quarterly";
  charges: number;
  lastChargedOn: string;
  nextExpectedOn: string;
  category: string | null;
  paidBy: string | null;
  annualizedInr: number;
}

const CYCLE_SHAPES = [
  { cycle: "monthly", days: 30.44, tolerance: 4 },
  { cycle: "quarterly", days: 91.31, tolerance: 9 },
] as const;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Which cycle every gap fits (whole cycles apart, at least one back-to-back), if any. */
function cycleOf(dates: readonly string[]): "monthly" | "quarterly" | null {
  const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index] ?? date, date));
  for (const shape of CYCLE_SHAPES) {
    let backToBack = false;
    const fits = gaps.every((gap) => {
      const cycles = Math.round(gap / shape.days);
      if (cycles < 1 || Math.abs(gap - cycles * shape.days) > shape.tolerance * cycles) return false;
      if (cycles === 1) backToBack = true;
      return true;
    });
    if (fits && backToBack) return shape.cycle;
  }
  return null;
}

function isTracked(key: string, trackedKeys: readonly string[]): boolean {
  return trackedKeys.some(
    (tracked) => tracked === key || (tracked.length >= 3 && key.length >= 3 && (key.includes(tracked) || tracked.includes(key))),
  );
}

/**
 * Vendors charged again and again at a similar amount (within 10% of their
 * median) on a monthly or quarterly rhythm. Vendors already tracked, and ones
 * that stopped charging more than two cycles ago, are left out.
 */
export function detectRecurringCharges(
  spends: readonly SpendSummary[],
  today: string,
  trackedVendors: readonly string[],
): { candidates: RecurringCandidate[]; skippedTracked: number } {
  const trackedKeys = trackedVendors.map(vendorKey).filter(Boolean);
  const byVendor = new Map<string, SpendSummary[]>();
  for (const spend of spends) {
    if (!spendDate(spend) || spend.amount <= 0) continue;
    const key = vendorKey(spend.vendor?.trim() || spend.spend);
    if (!key) continue;
    byVendor.set(key, [...(byVendor.get(key) ?? []), spend]);
  }

  const candidates: RecurringCandidate[] = [];
  let skippedTracked = 0;
  for (const [key, entries] of byVendor) {
    if (entries.length < 2) continue;
    const typical = median(entries.map((entry) => entry.amount));
    const similar = entries
      .filter((entry) => Math.abs(entry.amount - typical) <= Math.max(typical * 0.1, 1))
      .sort((a, b) => (spendDate(a) ?? "").localeCompare(spendDate(b) ?? ""));
    const dates = [...new Set(similar.map((entry) => spendDate(entry) ?? ""))];
    if (dates.length < 2) continue;
    const cycle = cycleOf(dates);
    if (!cycle) continue;
    const last = similar.at(-1);
    const lastDate = dates.at(-1);
    if (!last || !lastDate) continue;
    if (daysBetween(lastDate, today) > 2 * CYCLE_MONTHS[cycle] * 31) continue;
    if (isTracked(key, trackedKeys)) {
      skippedTracked += 1;
      continue;
    }
    candidates.push({
      vendor: last.vendor?.trim() || last.spend,
      amountInr: last.amount,
      cycle,
      charges: dates.length,
      lastChargedOn: lastDate,
      nextExpectedOn: nextRenewalOnOrAfter(addMonths(lastDate, CYCLE_MONTHS[cycle]), cycle, today),
      category: last.category,
      paidBy: last.paidBy.length ? last.paidBy.join(" & ") : null,
      annualizedInr: annualizedInr(last.amount, cycle),
    });
  }
  candidates.sort((a, b) => b.annualizedInr - a.annualizedInr || a.vendor.localeCompare(b.vendor));
  return { candidates: candidates.slice(0, 15), skippedTracked };
}

export function formatCandidates(
  result: { candidates: RecurringCandidate[]; skippedTracked: number },
  since: string,
): string {
  const skipped = result.skippedTracked
    ? `\n(${result.skippedTracked} repeating vendor${result.skippedTracked === 1 ? " is" : "s are"} already tracked and left out.)`
    : "";
  if (result.candidates.length === 0) {
    return `🔎 No new repeating charges in the spend log since ${dateLabel(since)}.${skipped}`;
  }
  const lines = [`🔎 Possible subscriptions in the spend log since ${dateLabel(since)}:`];
  result.candidates.forEach((candidate, index) => {
    lines.push(
      `${index + 1}. ${candidate.vendor} · ~${formatInr(candidate.amountInr)} ${candidate.cycle} · ${candidate.charges} charges, last ${dateLabel(candidate.lastChargedOn)} · next ~${dateLabel(candidate.nextExpectedOn)}${candidate.category ? ` · ${candidate.category}` : ""}`,
    );
  });
  lines.push('Nothing is tracked yet. To track some, reply to this message with e.g. "track 1 and 3" or "track all".');
  return lines.join("\n") + skipped;
}

// --- Budgets ------------------------------------------------------------------------

export interface BudgetLine {
  category: string;
  budgetInr: number;
  actualInr: number;
  remainingInr: number;
  percent: number | null;
}

export interface BudgetStatus {
  month: string;
  lines: BudgetLine[];
  unbudgeted: Array<{ category: string; actualInr: number }>;
  totalBudgetInr: number;
  totalActualInr: number;
}

export function budgetStatus(month: string, budgets: readonly BudgetRecord[], spends: readonly SpendSummary[]): BudgetStatus {
  const window = monthBounds(month);
  const actuals = new Map<string, { category: string; total: number }>();
  for (const spend of spends) {
    if (!inWindow(spend, window)) continue;
    const category = spend.category ?? "Uncategorized";
    const entry = actuals.get(category.toLowerCase()) ?? { category, total: 0 };
    entry.total += paise(spend.amount);
    actuals.set(category.toLowerCase(), entry);
  }
  let totalBudget = 0;
  let totalActual = 0;
  const lines = budgets.map((budget) => {
    const budgetPaise = paise(budget.amountInr);
    const actualPaise = actuals.get(budget.category.toLowerCase())?.total ?? 0;
    actuals.delete(budget.category.toLowerCase());
    totalBudget += budgetPaise;
    totalActual += actualPaise;
    return {
      category: budget.category,
      budgetInr: rupees(budgetPaise),
      actualInr: rupees(actualPaise),
      remainingInr: rupees(budgetPaise - actualPaise),
      percent: budgetPaise === 0 ? null : Math.round((actualPaise / budgetPaise) * 100),
    };
  });
  return {
    month,
    lines: lines.sort((a, b) => (b.percent ?? Infinity) - (a.percent ?? Infinity) || a.category.localeCompare(b.category)),
    unbudgeted: [...actuals.values()]
      .map((entry) => ({ category: entry.category, actualInr: rupees(entry.total) }))
      .sort((a, b) => b.actualInr - a.actualInr),
    totalBudgetInr: rupees(totalBudget),
    totalActualInr: rupees(totalActual),
  };
}

function budgetLine(line: { label: string; budgetInr: number; actualInr: number; remainingInr: number; percent: number | null }): string {
  const percent = line.percent === null ? "" : ` · ${line.percent}%`;
  const verdict =
    line.remainingInr < 0
      ? `⚠️ over by ${formatInr(-line.remainingInr)}`
      : `${formatInr(line.remainingInr)} left`;
  return `${line.label}: ${formatInr(line.actualInr)} of ${formatInr(line.budgetInr)}${percent} · ${verdict}`;
}

export function formatBudgetStatus(
  status: BudgetStatus,
  options: { today: string; spendLogAvailable: boolean; truncated: boolean },
): string {
  const { from, to } = monthBounds(status.month);
  const progress =
    options.today >= from && options.today <= to
      ? ` (day ${daysBetween(from, options.today) + 1} of ${daysBetween(from, to) + 1})`
      : "";
  const header = `🎯 Budget · ${monthLabel(status.month)}${progress}`;
  if (!options.spendLogAvailable) {
    if (status.lines.length === 0) return `${header}\nNo budgets set for this month.`;
    return [
      header,
      ...status.lines.map((line) => `• ${line.category}: ${formatInr(line.budgetInr)}`),
      `Total budget: ${formatInr(status.totalBudgetInr)}`,
      "Actual spend needs the Daily Spend Log, which is not configured.",
    ].join("\n");
  }
  const lines = [header];
  if (status.lines.length === 0) {
    lines.push("No budgets set for this month.");
  } else {
    for (const line of status.lines) lines.push(`• ${budgetLine({ ...line, label: line.category })}`);
    const remaining = Math.round((status.totalBudgetInr - status.totalActualInr) * 100) / 100;
    lines.push(
      budgetLine({
        label: "Total",
        budgetInr: status.totalBudgetInr,
        actualInr: status.totalActualInr,
        remainingInr: remaining,
        percent: status.totalBudgetInr === 0 ? null : Math.round((status.totalActualInr / status.totalBudgetInr) * 100),
      }),
    );
  }
  if (status.unbudgeted.length > 0) {
    lines.push(
      `Unbudgeted spend: ${status.unbudgeted.map((entry) => `${entry.category} ${formatInr(entry.actualInr)}`).join(", ")}`,
    );
  }
  if (options.truncated) lines.push("⚠️ Partial: the spend log returned more rows than Patch reads at once.");
  return lines.join("\n");
}
