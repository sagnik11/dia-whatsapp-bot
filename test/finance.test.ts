import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FinanceTools,
  isReceiptRequest,
  referencedSubscriptionIds,
} from "../src/assistant-finance.js";
import { DiaAssistant } from "../src/assistant.js";
import { SchemaGate } from "../src/d1-schema.js";
import {
  budgetStatus,
  detectRecurringCharges,
  formatBudgetStatus,
  formatCandidates,
  formatRollup,
  formatSettlement,
  settleReimbursements,
  summarizeSpends,
} from "../src/finance-report.js";
import {
  BudgetStore,
  FINANCE_SCHEMA_STATEMENTS,
  SubscriptionStore,
  addMonths,
  annualizedInr,
  nextRenewalOnOrAfter,
  shiftMonth,
} from "../src/finance-store.js";
import type { CompletionRequest, CompletionResult } from "../src/llm.js";
import { NotionSpendService } from "../src/notion-spend.js";
import { TaskStore } from "../src/task-store.js";
import type { SpendSummary } from "../src/types.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const NOW = "2026-11-04T06:30:00.000Z"; // Wednesday, 12:00 IST

let executor: ReturnType<typeof createSqliteExecutor> | undefined;
afterEach(() => {
  executor?.close();
  executor = undefined;
});

function stores(now = NOW) {
  executor ??= createSqliteExecutor();
  const db = executor;
  const clock = () => new Date(now);
  const schema = new SchemaGate(db, FINANCE_SCHEMA_STATEMENTS, logger, "Finance");
  return {
    db,
    subscriptions: new SubscriptionStore({ db, schema, timezone: "Asia/Kolkata", logger, now: clock }),
    budgets: new BudgetStore({ db, schema, timezone: "Asia/Kolkata", logger, now: clock }),
  };
}

function spend(overrides: Partial<SpendSummary>): SpendSummary {
  return {
    id: "page",
    url: "https://notion.so/page",
    spend: "Spend",
    amount: 0,
    date: "2026-10-01",
    paidBy: ["Sagnik"],
    category: "Other",
    paymentMethod: null,
    vendor: null,
    notes: null,
    reimbursable: false,
    ...overrides,
  };
}

const october = { from: "2026-10-01", to: "2026-10-31", label: "October 2026" };
const september = { from: "2026-09-01", to: "2026-09-30", label: "September 2026" };

const rollupSpends = [
  spend({ date: "2026-09-10", amount: 1000, category: "Software & SaaS" }),
  spend({ date: "2026-09-15", amount: 500, category: "Travel", paidBy: ["Tanvi"] }),
  spend({ date: "2026-10-02", amount: 1200.1, category: "Software & SaaS", vendor: "Notion" }),
  spend({ date: "2026-10-05", amount: 0.1, category: "Meals", paidBy: ["Tanvi"], paymentMethod: "UPI" }),
  spend({ date: "2026-10-06", amount: 0.2, category: "Meals", paidBy: ["Tanvi"], paymentMethod: "UPI" }),
  spend({ date: "2026-10-20", amount: 750, category: "Travel", paidBy: ["Tanvi"], paymentMethod: "Cash" }),
  spend({ date: "2026-11-01", amount: 99, category: "Travel" }),
];

const settlementSpends = [
  spend({ date: "2026-10-03", spend: "Uber to client", amount: 540, paymentMethod: "UPI", reimbursable: true }),
  spend({ date: "2026-10-09", spend: "Domain renewal", amount: 899, paymentMethod: "Personal card", reimbursable: true }),
  spend({ date: "2026-10-12", spend: "AWS", amount: 4200, paymentMethod: "Company card", reimbursable: true }),
  spend({ date: "2026-10-15", spend: "Chai", amount: 100, paymentMethod: "Cash" }),
  spend({ date: "2026-10-20", spend: "Courier", amount: 300, paidBy: ["Tanvi"], reimbursable: true }),
  spend({ date: "2026-09-30", spend: "Old", amount: 1000, paidBy: ["Tanvi"], reimbursable: true }),
];

const SETTLEMENT_TEXT = [
  "💸 Reimbursements · October 2026",
  "Company owes Sagnik ₹1,439 (2 entries):",
  "  • 3 Oct · Uber to client · ₹540 · UPI",
  "  • 9 Oct · Domain renewal · ₹899 · Personal card",
  "Company owes Tanvi ₹300 (1 entry):",
  "  • 20 Oct · Courier · ₹300",
  "Total to reimburse: ₹1,739",
  "ℹ️ Left out 1 reimbursable entry paid with a company method (₹4,200).",
].join("\n");

describe("Finance schema", () => {
  it("matches the checked-in D1 migration", () => {
    const migration = readFileSync(new URL("../migrations/0003_finance.sql", import.meta.url), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual(FINANCE_SCHEMA_STATEMENTS.map((s) => s.replace(/\s+/g, " ").trim()));
  });
});

describe("NotionSpendService.listAllSpends", () => {
  function service(query: ReturnType<typeof vi.fn>) {
    const notionSpend = new NotionSpendService({
      apiKey: "test-key",
      dataSourceId: "spend-source",
      payerMap: { tanvi: "user-tanvi" },
      logger,
    });
    Object.assign(notionSpend as unknown as { client: unknown }, { client: { dataSources: { query } } });
    return notionSpend;
  }

  const page = (id: string, amount: number) => ({
    object: "page",
    id,
    url: `https://notion.so/${id}`,
    properties: {
      Spend: { type: "title", title: [{ plain_text: id }] },
      Amount: { type: "number", number: amount },
      Date: { type: "date", date: { start: "2026-10-05" } },
      "Paid by": { type: "people", people: [{ id: "user-tanvi", name: "Tanvi" }] },
      Reimbursable: { type: "checkbox", checkbox: true },
    },
  });

  it("follows cursors across pages, oldest first, within the date range", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ results: [page("a", 100), page("b", 200)], has_more: true, next_cursor: "cursor-2" })
      .mockResolvedValueOnce({ results: [page("c", 300)], has_more: false, next_cursor: null });

    const result = await service(query).listAllSpends({ dateFrom: "2026-10-01", dateTo: "2026-10-31" });

    expect(result.truncated).toBe(false);
    expect(result.spends.map((s) => [s.spend, s.amount, s.paidBy, s.reimbursable])).toEqual([
      ["a", 100, ["Tanvi"], true],
      ["b", 200, ["Tanvi"], true],
      ["c", 300, ["Tanvi"], true],
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toEqual({
      data_source_id: "spend-source",
      filter: {
        and: [
          { property: "Date", date: { on_or_after: "2026-10-01" } },
          { property: "Date", date: { on_or_before: "2026-10-31" } },
        ],
      },
      sorts: [{ property: "Date", direction: "ascending" }],
      page_size: 100,
    });
    expect(query.mock.calls[1]?.[0]).toMatchObject({ start_cursor: "cursor-2" });
  });

  it("stops at the row cap and says the result is partial", async () => {
    const query = vi.fn().mockResolvedValue({ results: [page("a", 1), page("b", 2)], has_more: true, next_cursor: "more" });
    const result = await service(query).listAllSpends({ dateFrom: null, dateTo: null }, 3);
    expect(result.truncated).toBe(true);
    expect(result.spends).toHaveLength(3);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).not.toHaveProperty("filter");
  });
});

describe("calendar and money helpers", () => {
  it("clamps month math without drifting off the anchor day", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", -6)).toBe("2026-05-15");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(nextRenewalOnOrAfter("2026-01-31", "monthly", "2026-03-15")).toBe("2026-03-31");
    expect(nextRenewalOnOrAfter("2025-12-01", "yearly", "2026-11-04")).toBe("2026-12-01");
    expect(nextRenewalOnOrAfter("2026-12-01", "quarterly", "2026-11-04")).toBe("2026-12-01");
    expect(annualizedInr(1_500, "quarterly")).toBe(6_000);
  });
});

describe("spend roll-up", () => {
  it("totals by category with month-over-month change, in exact paise", () => {
    const rollup = summarizeSpends(rollupSpends, october, september, "category");
    expect(rollup).toMatchObject({ totalInr: 1950.4, count: 4, previousInr: 1500, previousCount: 2, changePct: 30 });
    expect(formatRollup(rollup, false)).toBe(
      [
        "📊 Spend · October 2026 · by category",
        "Total ₹1,950.4 · 4 entries · vs September 2026: ₹1,500 (+30%)",
        "• Software & SaaS: ₹1,200.1 (1) · +20%",
        "• Travel: ₹750 (1) · +50%",
        "• Meals: ₹0.3 (2) · new",
      ].join("\n"),
    );
  });

  it("groups by founder and payment method, and shows groups that went quiet", () => {
    const founders = summarizeSpends(rollupSpends, october, september, "founder");
    expect(founders.groups.map((g) => [g.label, g.totalInr, g.previousInr])).toEqual([
      ["Sagnik", 1200.1, 1000],
      ["Tanvi", 750.3, 500],
    ]);
    const methods = summarizeSpends(rollupSpends, october, september, "payment_method");
    expect(methods.groups.map((g) => g.label)).toEqual(["Not recorded", "Cash", "UPI"]);
    const vendors = formatRollup(summarizeSpends(rollupSpends, october, september, "vendor"), true);
    expect(vendors).toContain("• (no vendor): ₹750.3 (3) · −50%");
    expect(vendors).toContain("⚠️ Partial");
  });
});

describe("reimbursement settlement", () => {
  it("owes founders only for reimbursable, personally paid entries in the window", () => {
    const settlement = settleReimbursements(settlementSpends, october, new Set(["company card"]));
    expect(settlement.totalInr).toBe(1739);
    expect(formatSettlement(settlement, false)).toBe(SETTLEMENT_TEXT);
  });

  it("caps line items per founder and can filter to one founder", () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      spend({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, spend: `Cab ${index + 1}`, amount: 100, reimbursable: true }),
    );
    const text = formatSettlement(settleReimbursements([...many, ...settlementSpends], october, new Set(["company card"]), "sagnik"), false);
    expect(text).toContain("Company owes Sagnik ₹2,439 (12 entries):");
    expect(text).toContain("  … and 4 more (₹1,199)");
    expect(text).not.toContain("Tanvi");
  });
});

describe("subscription detection", () => {
  const history = [
    ...["06-02", "07-02", "08-02", "09-02", "10-02"].map((day, index) =>
      spend({ date: `2026-${day}`, vendor: "AWS", spend: "AWS bill", amount: [4100, 4180, 4210, 4200, 4250][index] ?? 0, category: "Hosting & Infrastructure" }),
    ),
    spend({ date: "2026-05-15", vendor: "Google Workspace", amount: 2000, category: "Software & SaaS" }),
    spend({ date: "2026-08-15", vendor: "Google Workspace", amount: 2000, category: "Software & SaaS" }),
    ...["06-01", "06-03", "06-10", "07-01"].map((day) => spend({ date: `2026-${day}`, vendor: "Uber", amount: 250 })),
    spend({ date: "2026-09-05", vendor: "Notion Labs", amount: 800 }),
    spend({ date: "2026-10-05", vendor: "Notion Labs", amount: 800 }),
    spend({ date: "2026-05-10", vendor: "Figma", amount: 1200 }),
    spend({ date: "2026-06-10", vendor: "Figma", amount: 1200 }),
    spend({ date: "2026-10-11", vendor: "Swiggy", amount: 640 }),
  ];

  it("finds regular charges at similar amounts and skips noise, tracked and stopped vendors", () => {
    const result = detectRecurringCharges(history, "2026-11-04", ["Notion"]);
    expect(result.skippedTracked).toBe(1);
    expect(result.candidates.map((c) => [c.vendor, c.cycle, c.charges, c.amountInr, c.nextExpectedOn])).toEqual([
      ["AWS", "monthly", 5, 4250, "2026-12-02"],
      ["Google Workspace", "quarterly", 2, 2000, "2026-11-15"],
    ]);
    expect(formatCandidates(result, "2026-05-04")).toBe(
      [
        "🔎 Possible subscriptions in the spend log since 4 May 2026:",
        "1. AWS · ~₹4,250 monthly · 5 charges, last 2 Oct 2026 · next ~2 Dec 2026 · Hosting & Infrastructure",
        "2. Google Workspace · ~₹2,000 quarterly · 2 charges, last 15 Aug 2026 · next ~15 Nov 2026 · Software & SaaS",
        'Nothing is tracked yet. To track some, reply to this message with e.g. "track 1 and 3" or "track all".',
        "(1 repeating vendor is already tracked and left out.)",
      ].join("\n"),
    );
  });
});

describe("budget status math", () => {
  it("compares actuals with budgets, most used first, and lists unbudgeted spend", () => {
    const budgets = [
      { id: 1, month: "2026-11", category: "Travel" as const, amountInr: 20_000, updatedBy: "Sagnik", updatedAt: NOW },
      { id: 2, month: "2026-11", category: "Meals" as const, amountInr: 1_000, updatedBy: "Sagnik", updatedAt: NOW },
    ];
    const spends = [
      spend({ date: "2026-11-02", category: "Travel", amount: 12_000 }),
      spend({ date: "2026-11-03", category: "Meals", amount: 1_500 }),
      spend({ date: "2026-11-03", category: "Office", amount: 400 }),
      spend({ date: "2026-10-31", category: "Travel", amount: 9_999 }),
    ];
    expect(
      formatBudgetStatus(budgetStatus("2026-11", budgets, spends), { today: "2026-11-04", spendLogAvailable: true, truncated: false }),
    ).toBe(
      [
        "🎯 Budget · November 2026 (day 4 of 30)",
        "• Meals: ₹1,500 of ₹1,000 · 150% · ⚠️ over by ₹500",
        "• Travel: ₹12,000 of ₹20,000 · 60% · ₹8,000 left",
        "Total: ₹13,500 of ₹21,000 · 64% · ₹7,500 left",
        "Unbudgeted spend: Office ₹400",
      ].join("\n"),
    );
  });
});

describe("SubscriptionStore", () => {
  it("adds, dedupes, lists the renewal radar, and rolls passed renewals forward on read", async () => {
    const { subscriptions, db } = stores();
    const added = await subscriptions.add(
      [
        { vendor: "Notion", plan: "Plus", amountInr: 800, cycle: "monthly", renewsOn: "2026-10-03", owner: "Tanvi", notes: null },
        { vendor: "AWS", plan: null, amountInr: 4200, cycle: "monthly", renewsOn: "2026-11-20", owner: null, notes: null },
        { vendor: "Figma", plan: null, amountInr: 12000, cycle: "yearly", renewsOn: "2027-03-01", owner: null, notes: null },
        { vendor: "notion", plan: "plus", amountInr: 900, cycle: "monthly", renewsOn: null, owner: null, notes: null },
      ],
      "Sagnik",
    );
    expect(added.map((r) => [r.subscription.id, r.subscription.renewsOn, r.duplicate])).toEqual([
      [1, "2026-12-03", false], // a past renewal date is moved to the next cycle
      [2, "2026-11-20", false],
      [3, "2027-03-01", false],
      [1, "2026-12-03", true],
    ]);

    const soon = await subscriptions.list({ statuses: ["active"], withinDays: 30, owner: null, vendor: null, limit: 50 });
    expect(soon.map((s) => s.vendor)).toEqual(["AWS", "Notion"]);

    const later = stores("2026-12-10T06:30:00.000Z").subscriptions;
    const rolled = await later.list({ statuses: ["active"], withinDays: null, owner: null, vendor: null, limit: 50 });
    expect(rolled.map((s) => [s.vendor, s.renewsOn])).toEqual([
      ["AWS", "2026-12-20"],
      ["Notion", "2027-01-03"],
      ["Figma", "2027-03-01"],
    ]);
    const audits = await db.query<{ action: string; actor: string }>(
      "SELECT action, actor FROM audit_events WHERE entity = 'subscription' AND action = 'renewal_rolled'",
    );
    expect(audits.results).toEqual([
      { action: "renewal_rolled", actor: "Patch" },
      { action: "renewal_rolled", actor: "Patch" },
    ]);
  });

  it("updates, cancels and soft-deletes with an audit trail", async () => {
    const { subscriptions, db } = stores();
    await subscriptions.add(
      [{ vendor: "Canva", plan: null, amountInr: 500, cycle: "monthly", renewsOn: "2026-11-10", owner: null, notes: null }],
      "Tanvi",
    );
    const patch = { vendor: null, plan: null, amountInr: null, cycle: null, renewsOn: null, owner: null, notes: null, status: null, remove: false };
    const bumped = await subscriptions.update(1, { ...patch, amountInr: 650, renewsOn: "2026-10-10" }, "Tanvi");
    expect(bumped).toMatchObject({ after: { amountInr: 650, renewsOn: "2026-11-10" }, rolled: true });
    const cancelled = await subscriptions.update(1, { ...patch, status: "cancelled" }, "Tanvi");
    expect(cancelled?.after).toMatchObject({ status: "cancelled" });
    expect(cancelled?.after.cancelledAt).not.toBeNull();
    expect(await subscriptions.list({ statuses: ["active"], withinDays: null, owner: null, vendor: null, limit: 50 })).toEqual([]);
    await subscriptions.update(1, { ...patch, remove: true }, "Tanvi");
    expect(await subscriptions.update(1, patch, "Tanvi")).toBeNull();
    const actions = await db.query<{ action: string }>("SELECT action FROM audit_events WHERE entity = 'subscription' ORDER BY id");
    expect(actions.results.map((row) => row.action)).toEqual(["created", "updated", "updated", "deleted"]);
  });
});

describe("BudgetStore", () => {
  it("creates, updates, keeps, removes and restores one budget per month and category", async () => {
    const { budgets } = stores();
    expect(budgets.currentMonth()).toBe("2026-11");
    await budgets.set(
      [
        { month: "2026-11", category: "Travel", amountInr: 20_000 },
        { month: "2026-11", category: "Meals", amountInr: 5_000 },
      ],
      "Sagnik",
    );
    const changes = await budgets.set(
      [
        { month: "2026-11", category: "Travel", amountInr: 25_000 },
        { month: "2026-11", category: "Meals", amountInr: 5_000 },
        { month: "2026-11", category: "Office", amountInr: null },
        { month: "2026-11", category: "Meals", amountInr: null },
      ],
      "Tanvi",
    );
    expect(changes.map((c) => [c.action, "budget" in c ? c.budget.amountInr : null])).toEqual([
      ["updated", 25_000],
      ["unchanged", 5_000],
      ["missing", null],
      ["removed", 5_000],
    ]);
    expect((await budgets.forMonth("2026-11")).map((b) => [b.category, b.amountInr])).toEqual([["Travel", 25_000]]);
    const [restored] = await budgets.set([{ month: "2026-11", category: "Meals", amountInr: 3_000 }], "Tanvi");
    expect(restored).toMatchObject({ action: "created", previousInr: null });
    expect((await budgets.forMonth("2026-11")).map((b) => b.category)).toEqual(["Meals", "Travel"]);
  });
});

function scripted(...turns: CompletionResult[]) {
  const requests: CompletionRequest[] = [];
  const complete = vi.fn(async (request: CompletionRequest) => {
    requests.push({ ...request, messages: [...request.messages] });
    const next = turns.shift();
    if (!next) throw new Error("out of turns");
    return next;
  });
  return { complete, requests };
}

function assistant(llm: ReturnType<typeof scripted>, spends: SpendSummary[] | null) {
  const s = stores();
  const spendLog = spends ? { listAllSpends: vi.fn().mockResolvedValue({ spends, truncated: false }) } : null;
  const addSpends = vi.fn().mockResolvedValue({
    paidBy: "Sagnik", results: [], createdCount: 1, duplicateCount: 0, failedCount: 0, createdAmount: 2360,
  });
  const finance = new FinanceTools(
    { subscriptions: s.subscriptions, budgets: s.budgets, ...(spendLog ? { spendLog } : {}) },
    { companyPaymentMethods: ["company card"], logger },
  );
  const bot = new DiaAssistant({
    llm,
    botName: "Patch",
    timezone: "Asia/Kolkata",
    tasks: new TaskStore({ db: s.db, timezone: "Asia/Kolkata", logger }),
    ...(spendLog ? { notionSpend: { addSpends } as never } : {}),
    modules: [finance],
    logger,
  });
  return { ...s, bot, finance, spendLog, addSpends };
}

const request = (body: string, extra: object = {}) => ({
  groupId: "g1",
  groupName: "HQ",
  messageId: "msg",
  requestedBy: "Sagnik",
  requestedById: "s@c.us",
  body,
  quotedMessage: null,
  recentContext: [],
  ...extra,
});

describe("Finance assistant tools", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("detects money intents and subscription references", () => {
    expect(isReceiptRequest("@patch log this bill")).toBe(true);
    expect(isReceiptRequest("what's on this bill?")).toBe(false);
    const { finance } = assistant(scripted(), []);
    expect(finance.detect("who owes whom for October?")).toBe(true);
    expect(finance.detect("what renews this month?")).toBe(true);
    expect(finance.detect("how are we doing against the budget")).toBe(true);
    expect(finance.detect("spend breakdown by vendor for Q3")).toBe(true);
    expect(finance.detect("track 1 and 3")).toBe(true);
    expect(finance.detect("chai 120 upi")).toBe(false);
    const withoutLog = new FinanceTools(stores(), { companyPaymentMethods: [], logger });
    expect(withoutLog.detect("add this receipt")).toBe(false);
    expect(withoutLog.detect("who owes whom for October?")).toBe(false);
    expect(referencedSubscriptionIds("cancel S3 and subscription 5; the AWS S3 bill stays")).toEqual(new Set([3, 5]));
  });

  it("logs a bill photo through add_spends with a forced tool call", async () => {
    const llm = scripted(
      toolTurn("r", "add_spends", {
        paid_by: "Sagnik",
        expenses: [{ spend: "Team dinner", amount: 2360, date: "2026-11-02", category: "Meals", payment_method: "UPI", vendor: "Toit", notes: "Invoice 4411, GST ₹360" }],
      }),
    );
    const { bot, addSpends } = assistant(llm, []);
    const reply = await bot.respond(
      request("@patch log this bill, paid on UPI", {
        attachments: [{ kind: "image", mimeType: "image/jpeg", fileName: "bill.jpg", dataBase64: "AAAA", sizeBytes: 3, transcript: null }],
      }),
    );
    expect(reply).toBe("✅ Spend log updated: 1 entry · ₹2,360 · paid by Sagnik.");
    expect(llm.requests[0]?.toolChoice).toBe("required");
    expect(llm.requests[0]?.system).toContain("Receipts:");
    expect(JSON.stringify(llm.requests[0]?.messages[0])).toContain("data:image/jpeg;base64,AAAA");
    expect(addSpends.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ vendor: "Toit", amount: 2360, date: "2026-11-02", notes: "Invoice 4411, GST ₹360" }),
    ]);
  });

  it("answers roll-ups and settlements directly from code", async () => {
    const llm = scripted(
      toolTurn("s", "spend_summary", { month: "2026-10" }),
      toolTurn("r", "reimbursement_settlement", { month: "2026-10" }),
      toolTurn("m", "spend_summary", { group_by: "founder" }),
    );
    const { bot, spendLog } = assistant(llm, [...rollupSpends, ...settlementSpends]);
    const rollup = await bot.respond(request("@patch October spend summary"));
    expect(rollup).toContain("📊 Spend · October 2026 · by category\nTotal ₹7,989.4 · 9 entries");
    expect(spendLog?.listAllSpends).toHaveBeenCalledWith({ dateFrom: "2026-09-01", dateTo: "2026-10-31" });
    expect(await bot.respond(request("@patch who owes whom for October?"))).toBe(SETTLEMENT_TEXT);
    expect(await bot.respond(request("@patch spend breakdown by founder this month"))).toBe(
      "📊 Spend · November 2026 to date · by founder\nTotal ₹99 · 1 entry · vs 1–4 Oct 2026: ₹1,740.1 (−94%)\n• Sagnik: ₹99 (1) · −94%",
    );
    expect(llm.complete).toHaveBeenCalledTimes(3);
  });

  it("returns bad periods to the model instead of guessing", async () => {
    const llm = scripted(
      toolTurn("a", "spend_summary", { month: "2026-13" }, ["b", "spend_summary", { month: "2026-12" }]),
      textTurn("Which month did you mean?"),
    );
    const { bot } = assistant(llm, []);
    expect(await bot.respond(request("@patch spend summary for the 13th month"))).toBe("Which month did you mean?");
    const second = JSON.stringify(llm.requests[1]?.messages);
    expect(second).toContain("Invalid arguments for spend_summary: month: must be a YYYY-MM month");
    expect(second).toContain("2026-12 has not started yet");
  });

  it("tracks, guards, updates and cancels subscriptions by S id", async () => {
    const llm = scripted(
      toolTurn("a", "add_subscriptions", { subscriptions: [{ vendor: "Notion", plan: "Plus", amount_inr: 800, cycle: "Monthly", renews_on: "2026-12-03", owner: "me" }] }),
      toolTurn("u", "update_subscription", { subscription_id: 1, amount_inr: 1500 }),
      textTurn("Which subscription?"),
      toolTurn("l", "list_subscriptions", { vendor: "notion" }),
      toolTurn("u2", "update_subscription", { subscription_id: 1, amount_inr: "₹1,000" }),
      toolTurn("c", "update_subscription", { subscription_id: 1, status: "cancelled" }),
    );
    const { bot } = assistant(llm, null);
    expect(await bot.respond(request("@patch track our Notion Plus subscription, ₹800 a month, renews 3 Dec"))).toBe(
      "📦 Tracking 1 subscription:\n• S1 Notion (Plus) — ₹800/month · renews 3 Dec 2026 (in 29 days) · owner Sagnik",
    );
    expect(await bot.respond(request("@patch bump that plan to 1500"))).toBe("Which subscription?");
    expect(JSON.stringify(llm.requests[2]?.messages)).toContain("S1 was neither named by the founder");

    expect(await bot.respond(request("@patch Notion went up to ₹1,000"))).toBe(
      "✅ S1 Notion (Plus) — ₹1,000/month · renews 3 Dec 2026 (in 29 days) · owner Sagnik\nChanged: amount ₹800 → ₹1,000.",
    );
    expect(JSON.stringify(llm.requests[4]?.messages)).toContain("Annualized: ₹9,600");
    expect(await bot.respond(request("@patch cancel S1"))).toBe(
      "🛑 Cancelled S1 Notion (Plus) — ₹1,000/month. It is off the renewal radar.",
    );
  });

  it("finds subscription candidates without adding any", async () => {
    const llm = scripted(toolTurn("d", "detect_subscriptions", {}));
    const { bot, subscriptions } = assistant(llm, [
      spend({ date: "2026-09-12", vendor: "Vercel", amount: 1700, category: "Hosting & Infrastructure" }),
      spend({ date: "2026-10-12", vendor: "Vercel", amount: 1720, category: "Hosting & Infrastructure" }),
    ]);
    expect(await bot.respond(request("@patch which subscriptions are we paying for?"))).toContain(
      "1. Vercel · ~₹1,720 monthly · 2 charges, last 12 Oct 2026 · next ~12 Nov 2026",
    );
    expect(await subscriptions.list({ statuses: ["active"], withinDays: null, owner: null, vendor: null, limit: 50 })).toEqual([]);
  });

  it("sets budgets and reports them without a spend log", async () => {
    const llm = scripted(
      toolTurn("s", "set_budgets", { budgets: [{ category: "travel", amount_inr: 20000 }, { category: "SaaS", amount_inr: "₹40,000" }] }),
      toolTurn("b", "budget_status", {}),
    );
    const { bot } = assistant(llm, null);
    expect(await bot.respond(request("@patch budget 20k for travel and 40k for SaaS this month"))).toBe(
      "🎯 Budgets saved:\n• November 2026 · Travel: ₹20,000 (new)\n• November 2026 · Software & SaaS: ₹40,000 (new)",
    );
    const offered = (llm.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(offered).toContain("set_budgets");
    expect(offered).not.toContain("spend_summary");
    expect(await bot.respond(request("@patch how's the budget?"))).toBe(
      [
        "🎯 Budget · November 2026 (day 4 of 30)",
        "• Software & SaaS: ₹40,000",
        "• Travel: ₹20,000",
        "Total budget: ₹60,000",
        "Actual spend needs the Daily Spend Log, which is not configured.",
      ].join("\n"),
    );
  });
});
