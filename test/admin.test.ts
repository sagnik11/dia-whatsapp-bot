import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAdminRequest, referencedAdminIds } from "../src/admin-detect.js";
import { ADMIN_SCHEMA_STATEMENTS } from "../src/admin-schema.js";
import { AdminTools } from "../src/assistant-admin.js";
import { DiaAssistant } from "../src/assistant.js";
import { CandidateStore } from "../src/candidate-store.js";
import {
  ComplianceStore,
  createComplianceJob,
  inferComplianceArea,
  nextDueOn,
} from "../src/compliance-store.js";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "../src/d1-schema.js";
import { formatValue, impliedUnit, parseIndianNumber } from "../src/indian-number.js";
import { InvestorUpdateDrafter } from "../src/investor-update.js";
import type { CompletionRequest, CompletionResult } from "../src/llm.js";
import { MemoryStore } from "../src/memory-store.js";
import { MetricStore } from "../src/metrics-store.js";
import { PipelineStore } from "../src/pipeline-store.js";
import { ProactiveScheduler } from "../src/scheduler.js";
import { TaskStore, type TaskCreateInput } from "../src/task-store.js";
import type { ToolOutcome } from "../src/tool-outcome.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const TZ = "Asia/Kolkata";
const NOW = "2026-11-04T06:30:00.000Z"; // Wednesday, 12:00 IST

let executor: ReturnType<typeof createSqliteExecutor> | undefined;
afterEach(() => {
  executor?.close();
  executor = undefined;
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

async function services(now = NOW, llm = scripted()) {
  executor = createSqliteExecutor();
  let current = new Date(now);
  const clock = () => current;
  const db = executor;
  const phase1 = new SchemaGate(db, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
  await phase1.ensure();
  const schema = new SchemaGate(db, ADMIN_SCHEMA_STATEMENTS, logger, "Admin and ops");
  const options = { db, schema, timezone: TZ, logger, now: clock };
  const tasks = new TaskStore({ db, timezone: TZ, logger, now: clock });
  const memory = new MemoryStore({ db, schema: phase1, logger, now: clock });
  const stores = {
    compliance: new ComplianceStore({ ...options, defaultLeadDays: 14 }),
    metrics: new MetricStore(options),
    deals: new PipelineStore(options),
    candidates: new CandidateStore(options),
  };
  const module = new AdminTools(
    { ...stores, tasks, memory, drafter: new InvestorUpdateDrafter({ llm, logger }) },
    { timezone: TZ, staleDays: 14, logger },
  );
  return {
    db,
    tasks,
    memory,
    llm,
    module,
    ...stores,
    setNow: (iso: string) => void (current = new Date(iso)),
    job: createComplianceJob({ compliance: stores.compliance, tasks, timezone: TZ, logger }),
  };
}

const request = (body: string, extra: object = {}) => ({
  groupId: "g1",
  groupName: "HQ",
  messageId: `msg-${body.length}`,
  requestedBy: "Sagnik",
  requestedById: "s@c.us",
  body,
  quotedMessage: null,
  recentContext: [],
  ...extra,
});

function payload(outcome: ToolOutcome | null): Record<string, unknown> {
  if (outcome?.kind !== "output") throw new Error(`expected output, got ${JSON.stringify(outcome)}`);
  return outcome.payload as Record<string, unknown>;
}

function draft(title: string, extra: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return { title, notes: null, status: null, priority: null, owner: null, area: null, dueAt: null, tags: [], ...extra };
}

describe("admin schema", () => {
  it("matches the checked-in D1 migration", () => {
    const migration = readFileSync(new URL("../migrations/0004_admin.sql", import.meta.url), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual(ADMIN_SCHEMA_STATEMENTS.map((s) => s.replace(/\s+/g, " ").trim()));
  });
});

describe("Indian number parsing", () => {
  it("reads lakh, crore, thousand and Indian digit grouping", () => {
    expect(parseIndianNumber("1.2L")).toBe(120_000);
    expect(parseIndianNumber("1.2 lakh")).toBe(120_000);
    expect(parseIndianNumber("3 lakhs")).toBe(300_000);
    expect(parseIndianNumber("₹2.5 Cr")).toBe(25_000_000);
    expect(parseIndianNumber("2 crore")).toBe(20_000_000);
    expect(parseIndianNumber("12k")).toBe(12_000);
    expect(parseIndianNumber("Rs. 40k")).toBe(40_000);
    expect(parseIndianNumber("1,20,000")).toBe(120_000);
    expect(parseIndianNumber("INR 1,20,000.50")).toBe(120_000.5);
    expect(parseIndianNumber("0.07L")).toBe(7_000);
    expect(parseIndianNumber("41")).toBe(41);
    expect(parseIndianNumber(3)).toBe(3);
    expect(parseIndianNumber("-5%")).toBe(-5);
  });

  it("refuses to guess at anything else", () => {
    for (const value of ["", "lots", "1.2x", "1.2.3", "L", "12 lakh crore", Number.NaN]) {
      expect(parseIndianNumber(value)).toBeNull();
    }
  });

  it("infers units and formats values the Indian way", () => {
    expect(impliedUnit("₹40k")).toBe("INR");
    expect(impliedUnit("Rs 1.2L")).toBe("INR");
    expect(impliedUnit("12%")).toBe("%");
    expect(impliedUnit("41")).toBeNull();
    expect(formatValue(120_000, "INR")).toBe("₹1,20,000");
    expect(formatValue(25_000_000, "inr")).toBe("₹2,50,00,000");
    expect(formatValue(41, "repos")).toBe("41 repos");
    expect(formatValue(12.5, "%")).toBe("12.5%");
  });
});

describe("compliance date math", () => {
  it("rolls periods forward anchored to the original day", () => {
    expect(nextDueOn("2027-01-31", "monthly", 31)).toBe("2027-02-28");
    expect(nextDueOn("2027-02-28", "monthly", 31)).toBe("2027-03-31");
    expect(nextDueOn("2026-11-20", "monthly")).toBe("2026-12-20");
    expect(nextDueOn("2026-12-20", "monthly")).toBe("2027-01-20");
    expect(nextDueOn("2026-11-30", "quarterly", 30)).toBe("2027-02-28");
    expect(nextDueOn("2028-02-29", "yearly", 29)).toBe("2029-02-28");
    expect(nextDueOn("2026-11-30", "none")).toBeNull();
  });

  it("files tax and payroll under Finance and the rest under Legal", () => {
    expect(inferComplianceArea("GSTR-3B", "GSTN")).toBe("Finance");
    expect(inferComplianceArea("TDS return Q2", null)).toBe("Finance");
    expect(inferComplianceArea("PF payment", "EPFO")).toBe("Finance");
    expect(inferComplianceArea("DIR-3 KYC", "MCA")).toBe("Legal");
    expect(inferComplianceArea("Trademark renewal", null)).toBe("Legal");
  });
});

describe("admin intent detection", () => {
  it("detects admin requests and the ids founders name", () => {
    expect(isAdminRequest("@patch MRR 1.2L, 3 pilots, 41 repos — log these metrics")).toBe(true);
    expect(isAdminRequest("add Acme to pilots, next step DPA")).toBe(true);
    expect(isAdminRequest("draft October's investor update")).toBe(true);
    expect(isAdminRequest("here's the compliance list from our CA")).toBe(true);
    expect(isAdminRequest("move C2 to interview")).toBe(true);
    expect(isAdminRequest("what's for lunch?")).toBe(false);
    expect(referencedAdminIds("mark CO3 and compliance 4 done, move P2 and deal 7, C5 to offer")).toEqual({
      compliance: new Set([3, 4]),
      deals: new Set([2, 7]),
      candidates: new Set([5]),
    });
    expect(referencedAdminIds("our co2 footprint and p1 bugs").compliance.size).toBe(0);
  });
});

describe("compliance register and silent job", () => {
  const item = (name: string, dueOn: string, extra: object = {}) => ({
    name,
    authority: null,
    area: null,
    dueOn,
    recurrence: "none" as const,
    owner: null,
    leadDays: null,
    checklist: null,
    notes: null,
    ...extra,
  });

  it("adds each period's task once, never posts, and rolls recurring items forward", async () => {
    const s = await services();
    const added = await s.compliance.add(
      [
        item("GSTR-3B", "2026-11-20", { authority: "GSTN", recurrence: "monthly", owner: "Tanvi", checklist: "Sales register\nPurchase register" }),
        item("DIR-3 KYC", "2026-11-15", { authority: "MCA", recurrence: "yearly", owner: "Sagnik" }),
        item("Advance tax Q3", "2026-12-15"),
      ],
      "Sagnik",
    );
    expect(added.map((r) => [r.item.id, r.item.area, r.duplicate])).toEqual([
      [1, "Finance", false],
      [2, "Legal", false],
      [3, "Finance", false],
    ]);
    expect((await s.compliance.add([item("gstr-3b", "2026-12-20")], "Tanvi"))[0]).toMatchObject({ duplicate: true, item: { id: 1 } });

    const send = vi.fn();
    const nowMs = Date.parse(NOW);
    await s.job.run(nowMs, send);
    await s.job.run(nowMs, send);
    expect(send).not.toHaveBeenCalled();
    let open = (await s.tasks.listOpen()).tasks;
    expect(open.map((t) => [t.title, t.dueAt, t.owner, t.area, t.tags])).toEqual([
      ["DIR-3 KYC", "2026-11-15", "Sagnik", "Legal", ["compliance"]],
    ]);
    expect(open[0]?.notes).toContain("CO2 done");

    // Even with the register's marker lost, the source message id stops a second task.
    s.db.raw.prepare("UPDATE compliance_items SET task_id = NULL, task_due_on = NULL").run();
    await s.job.run(nowMs, send);
    expect((await s.tasks.listOpen()).tasks).toHaveLength(1);

    s.setNow("2026-11-06T04:00:00.000Z"); // GSTR-3B's 14-day window opens today
    await s.job.run(Date.parse("2026-11-06T04:00:00.000Z"), send);
    open = (await s.tasks.listOpen()).tasks;
    expect(open.map((t) => [t.title, t.dueAt, t.area])).toEqual([
      ["DIR-3 KYC", "2026-11-15", "Legal"],
      ["GSTR-3B", "2026-11-20", "Finance"],
    ]);
    expect(open[1]?.notes).toContain("Sales register");

    const done = await s.compliance.markDone(1, "Tanvi");
    expect(done?.after).toMatchObject({ dueOn: "2026-12-20", status: "active", lastDoneOn: "2026-11-06" });
    const oneOff = await s.compliance.markDone(3, "Tanvi");
    expect(oneOff?.after).toMatchObject({ dueOn: "2026-12-15", status: "archived" });
    expect((await s.compliance.list({ statuses: ["active"], dueFrom: null, dueTo: null, owner: null, limit: 10 })).map((i) => i.id)).toEqual([2, 1]);

    s.setNow("2026-12-06T04:00:00.000Z");
    await s.job.run(Date.parse("2026-12-06T04:00:00.000Z"), send);
    const gst = (await s.tasks.listOpen()).tasks.filter((t) => t.title === "GSTR-3B");
    expect(gst.map((t) => t.dueAt)).toEqual(["2026-11-20", "2026-12-20"]);
    expect(send).not.toHaveBeenCalled();
    const audits = s.db.raw.prepare("SELECT action FROM audit_events WHERE entity = 'compliance_item' ORDER BY id").all();
    expect(audits.map((a) => (a as { action: string }).action)).toEqual(["created", "created", "created", "done", "done"]);
  });
});

describe("admin tools through the assistant", () => {
  async function assistant(...turns: CompletionResult[]) {
    const llm = scripted(...turns);
    const s = await services(NOW, llm);
    const bot = new DiaAssistant({ llm, botName: "Patch", timezone: TZ, tasks: s.tasks, modules: [s.module], logger });
    return { ...s, bot };
  }

  it("guards compliance ids and closes the period's task when a filing is done", async () => {
    const s = await assistant(
      toolTurn("a", "add_compliance_items", {
        items: [{ name: "GSTR-3B", authority: "GSTN", due_on: "2026-11-10", recurrence: "Monthly", owner: "me" }],
      }),
      toolTurn("u1", "update_compliance", { updates: [{ compliance_id: 1, action: "done" }] }),
      textTurn("Which filing? Name it by CO id."),
      toolTurn("u2", "update_compliance", { updates: [{ compliance_id: 1, action: "done" }, { compliance_id: 1, action: "done" }] }),
    );
    expect(await s.bot.respond(request("@patch our CA says: GSTR-3B monthly, next due 10 Nov"))).toBe(
      [
        "📋 Compliance register: 1 added.",
        "• CO1 GSTR-3B (GSTN) · due 10 Nov 2026 · monthly · owner Sagnik · task lands within the hour",
        "Tasks are added quietly ahead of each date; nothing is posted.",
      ].join("\n"),
    );
    expect(s.llm.requests[0]?.toolChoice).toBe("required");
    await s.job.run(Date.parse(NOW), vi.fn());

    expect(await s.bot.respond(request("@patch the GST filing is done"))).toBe("Which filing? Name it by CO id.");
    expect(JSON.stringify(s.llm.requests[2]?.messages)).toContain("Nothing was changed. CO1 was neither named");
    expect((await s.compliance.get(1))?.dueOn).toBe("2026-11-10");

    expect(await s.bot.respond(request("@patch CO1 is filed, mark it done"))).toBe(
      [
        "✅ CO1 GSTR-3B done for 10 Nov 2026. Next due 10 Dec 2026; task lands 26 Nov 2026. Task #1 closed too.",
        "⚠️ CO1 was already marked done in this message; it moved forward once.",
      ].join("\n"),
    );
    expect((await s.tasks.get(1))?.status).toBe("done");
    expect((await s.compliance.get(1))?.dueOn).toBe("2026-12-10");
  });

  it("logs metrics in Indian formats and rejects unreadable values", async () => {
    const s = await assistant(
      toolTurn("m", "log_metrics", {
        metrics: [
          { name: "MRR", value: "1.2L", unit: "₹" },
          { name: "Pilots", value: 3 },
          { name: "repos", value: "41" },
        ],
      }),
      toolTurn("bad", "log_metrics", { metrics: [{ name: "burn", value: "a lot" }] }),
      textTurn("What was the burn in rupees?"),
    );
    expect(await s.bot.respond(request("@patch metrics: MRR 1.2L, 3 pilots, 41 repos"))).toBe(
      [
        "📈 Logged 3 metrics:",
        "• mrr: ₹1,20,000 (as of 4 Nov 2026)",
        "• pilots: 3 (as of 4 Nov 2026)",
        "• repos: 41 (as of 4 Nov 2026)",
      ].join("\n"),
    );
    expect(await s.bot.respond(request("@patch log metric burn: a lot"))).toBe("What was the burn in rupees?");
    expect(JSON.stringify(s.llm.requests[2]?.messages)).toContain("is not a number Patch can read");
    expect((await s.metrics.latest(null)).map((m) => [m.name, m.current.value, m.unit])).toEqual([
      ["mrr", 120_000, "INR"],
      ["pilots", 3, null],
      ["repos", 41, null],
    ]);
  });

  it("only updates deals and candidates that were named or listed in the request", async () => {
    const s = await assistant(
      toolTurn("c", "create_deals", { deals: [{ company: "Acme", contact: "Rahul", stage: "pilot", value_inr: "4.8L", owner: "me" }] }),
      toolTurn("u", "update_deals", { updates: [{ deal_id: 1, stage: "negotiation" }] }),
      textTurn("Which deal?"),
      toolTurn("l", "list_pipeline", { text: "acme" }),
      toolTurn("u2", "update_deals", { updates: [{ deal_id: 1, stage: "negotiation", next_step: "Send the DPA", next_step_at: "2026-11-06" }] }),
      toolTurn("k", "create_candidates", { candidates: [{ name: "Priya", role: "Founding engineer", stage: "screen" }] }),
      toolTurn("k2", "update_candidates", { updates: [{ candidate_id: 1, stage: "interview" }] }),
    );
    expect(await s.bot.respond(request("@patch add Acme to pilots, ₹4.8L"))).toBe(
      "🤝 Pipeline: 1 added.\n• P1 Acme (Rahul) · pilot · ₹4,80,000 · owner Sagnik",
    );
    expect(await s.bot.respond(request("@patch move the Acme deal forward"))).toBe("Which deal?");
    expect(JSON.stringify(s.llm.requests[2]?.messages)).toContain("P1 was neither named");
    expect(await s.bot.respond(request("@patch Acme is in negotiation now, next step DPA by Friday"))).toBe(
      "✅ P1 Acme (Rahul) · negotiation · ₹4,80,000 · next: Send the DPA by 6 Nov 2026 · owner Sagnik (pilot → negotiation)",
    );
    expect(await s.bot.respond(request("@patch new candidate Priya for founding engineer, screening"))).toBe(
      "🧑‍💼 Hiring: 1 added.\n• C1 Priya — Founding engineer · screen",
    );
    expect(await s.bot.respond(request("@patch move C1 to interview"))).toBe(
      "✅ C1 Priya — Founding engineer · interview (screen → interview)",
    );
  });
});

describe("metric trends and pipeline flags", () => {
  it("returns one value per date (corrections win) with absolute and percent change", async () => {
    const s = await services();
    const log = (value: number, asOf: string, messageId: string) =>
      s.metrics.log([{ name: "MRR", value, unit: "INR", asOf, note: null }], { actor: "Tanvi", messageId });
    await log(100_000, "2026-09-30", "m1");
    await log(110_000, "2026-10-31", "m2");
    await log(115_000, "2026-10-31", "m3"); // correction for the same date
    await log(120_000, "2026-11-04", "m4");
    expect((await log(120_000, "2026-11-04", "m4"))[0]?.duplicate).toBe(true);

    const trend = payload(await s.module.begin(request("@patch MRR trend"), new Set()).handle("metric_trend", { name: "mrr", since: "2026-09-01" }));
    expect(trend).toMatchObject({ name: "mrr", absoluteChange: 20_000, percentChange: 20 });
    expect((trend.points as Array<{ display: string }>).map((p) => p.display)).toEqual(["₹1,00,000", "₹1,15,000", "₹1,20,000"]);
    expect(await s.metrics.monthSummary("2026-10")).toMatchObject([
      { name: "mrr", current: { value: 115_000 }, previous: { value: 100_000 }, absoluteChange: 15_000, percentChange: 15 },
    ]);
  });

  it("flags open deals that are stuck or have no next step", async () => {
    const s = await services("2026-10-01T06:30:00.000Z");
    await s.deals.create(
      [{ title: "Acme", detail: null, stage: "pilot", valueInr: 480_000, next: null, nextAt: null, owner: "Sagnik", notes: null }],
      "Sagnik",
    );
    s.setNow(NOW);
    await s.deals.create(
      [{ title: "Globex", detail: "Mira", stage: "lead", valueInr: null, next: "Intro call", nextAt: "2026-11-01", owner: null, notes: null }],
      "Tanvi",
    );
    const list = payload(await s.module.begin(request("@patch pipeline?"), new Set()).handle("list_pipeline", {}));
    expect(list).toMatchObject({ count: 2, byStage: { lead: 1, pilot: 1 }, openValueInr: "₹4,80,000" });
    expect((list.items as Array<{ ref: string; flags: string[] }>).map((i) => [i.ref, i.flags])).toEqual([
      ["P2", ["next step overdue"]],
      ["P1", ["stuck 34 days in pilot", "no next step"]],
    ]);
  });
});

describe("investor update draft", () => {
  it("hands the model only that month's stored data and labels the reply a draft", async () => {
    const llm = scripted(textTurn("*Highlights*\n- Shipped onboarding v2"));
    const s = await services("2026-10-20T06:30:00.000Z", llm);
    await s.tasks.create([draft("Ship onboarding v2", { area: "Product", status: "done" })], { actor: "Tanvi", groupName: null, messageId: "t1" });
    await s.tasks.create([draft("Open task stays out")], { actor: "Tanvi", groupName: null, messageId: "t2" });
    await s.metrics.log([{ name: "mrr", value: 100_000, unit: "INR", asOf: "2026-09-30", note: null }], { actor: "Tanvi", messageId: "a" });
    await s.metrics.log([{ name: "mrr", value: 115_000, unit: "INR", asOf: "2026-10-31", note: null }], { actor: "Tanvi", messageId: "b" });
    await s.memory.add("g1", [{ kind: "decision", subject: "pricing", content: "Price per repo from December.", sourceAuthor: "Sagnik", sourceMessageId: "d", observedAt: "2026-10-15T05:00:00.000Z" }], "Sagnik");
    await s.memory.add("g2", [{ kind: "decision", subject: "secret", content: "Other group decision.", sourceAuthor: "X", sourceMessageId: "e", observedAt: "2026-10-15T05:00:00.000Z" }], "X");
    await s.deals.create([{ title: "Acme", detail: "Rahul", stage: "pilot", valueInr: null, next: "Send the DPA", nextAt: null, owner: null, notes: null }], "Sagnik");
    s.setNow("2026-11-04T06:30:00.000Z");
    await s.tasks.create([draft("November work stays out", { status: "done" })], { actor: "Tanvi", groupName: null, messageId: "t3" });

    const outcome = await s.module.begin(request("@patch draft October's investor update"), new Set()).handle("draft_investor_update", {});
    expect(outcome).toEqual({
      kind: "final",
      text: "📝 *DRAFT* investor update for October 2026. Not sent anywhere; check every line before you send it yourselves.\n\n*Highlights*\n- Shipped onboarding v2",
    });
    const sent = llm.requests[0];
    expect(sent?.system).toContain("Use only the supplied JSON data");
    expect(sent?.system).toContain("Highlights, Metrics, Product, Customers/pipeline, Hiring, Asks");
    const data = String(sent?.messages[0]?.content);
    for (const fact of ["Ship onboarding v2", "₹1,15,000", "₹1,00,000", "15%", "Price per repo from December.", "Acme", "Send the DPA"]) {
      expect(data).toContain(fact);
    }
    for (const outside of ["Open task stays out", "November work stays out", "Other group decision."]) {
      expect(data).not.toContain(outside);
    }

    const empty = await s.module.begin(request("@patch investor update for August"), new Set()).handle("draft_investor_update", { month: "2026-08" });
    expect(empty).toMatchObject({ kind: "final", text: expect.stringContaining("Nothing is stored for August 2026") });
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });
});

describe("compliance job in the scheduler", () => {
  it("runs as a silent plug-in job and moves its task when the CA corrects a date", async () => {
    const s = await services();
    await s.compliance.add(
      [{ name: "DIR-3 KYC", authority: "MCA", area: null, dueOn: "2026-11-15", recurrence: "yearly", owner: "Sagnik", leadDays: null, checklist: null, notes: null }],
      "Sagnik",
    );
    const send = vi.fn();
    const scheduler = new ProactiveScheduler({
      reminders: { due: vi.fn().mockReturnValue([]) } as never,
      tasks: { listOpen: vi.fn() },
      timezone: TZ,
      logger,
      jobs: [s.job],
    });
    await scheduler.runOnce(Date.parse(NOW), send);
    expect(send).not.toHaveBeenCalled();
    expect((await s.tasks.get(1))?.title).toBe("DIR-3 KYC");

    const outcome = await s.module
      .begin(request("@patch CO1: the CA says the due date is 30 Nov"), new Set())
      .handle("update_compliance", { updates: [{ compliance_id: 1, action: "edit", due_on: "2026-11-30" }] });
    expect(outcome).toEqual({
      kind: "final",
      text: "✏️ CO1 DIR-3 KYC (MCA) · due 30 Nov 2026 · yearly · owner Sagnik · task #1 moved to 30 Nov 2026",
    });
    expect((await s.tasks.get(1))?.dueAt).toBe("2026-11-30");
    await s.job.run(Date.parse(NOW) + 3_600_000, send);
    expect((await s.tasks.listOpen()).tasks).toHaveLength(1);
  });
});
