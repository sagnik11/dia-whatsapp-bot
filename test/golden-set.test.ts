import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createEvalEnvironment, evalRequest } from "../eval/environment.js";
import {
  ACCURACY_THRESHOLD,
  READ_ONLY_TOOLS,
  RecordingModel,
  WRITE_TOOLS,
  filterCases,
  formatReport,
  goldenSetSchema,
  loadGoldenSet,
  matchesPartial,
  parseEvalArgs,
  readEvalEnv,
  scoreCase,
  summarize,
  type CaseResult,
  type GoldenCase,
} from "../eval/harness.js";
import type { CompletionRequest, CompletionResult, LanguageModel } from "../src/llm.js";
import { createLogger } from "../src/logger.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";

const logger = createLogger("silent");
const golden = loadGoldenSet();

/** Every tool the production-shaped eval assistant offers on an unforced turn. */
async function offeredToolNames(): Promise<string[]> {
  const recorder = new RecordingModel({ complete: async () => textTurn("Hello!") });
  const environment = await createEvalEnvironment(recorder, logger);
  try {
    await environment.assistant.respond(evalRequest({ id: "probe", message: "hello" }));
  } finally {
    environment.close();
  }
  return recorder.offeredTools;
}

describe("golden set shape", () => {
  it("holds 50-60 valid, uniquely named cases", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(50);
    expect(golden.cases.length).toBeLessThanOrEqual(60);
    const raw: unknown = JSON.parse(readFileSync(new URL("../eval/golden-set.json", import.meta.url), "utf8"));
    expect(goldenSetSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects duplicate ids and unknown fields", () => {
    const one = { id: "a", category: "tasks", message: "hi", expect: { firstTools: [] } };
    expect(goldenSetSchema.safeParse({ description: "", cases: [one, one] }).success).toBe(false);
    expect(goldenSetSchema.safeParse({ description: "", cases: [{ ...one, expected: {} }] }).success).toBe(false);
    expect(goldenSetSchema.safeParse({ description: "", cases: [{ ...one, expect: { firstTools: [], extra: 1 } }] }).success).toBe(false);
  });

  it("covers every kind of founder command the plan names", () => {
    const categories = new Set(golden.cases.map((goldenCase) => goldenCase.category));
    for (const category of [
      "tasks", "task-reads", "task-edits", "task-deletes", "write-safety", "spends", "brain-dump", "reminders",
      "conversation", "memory", "follow-ups", "recurring", "checklists", "undo", "research", "chit-chat", "export",
    ]) {
      expect(categories, category).toContain(category);
    }
  });

  it("includes write-safety cases for reads, ambiguous edits and quoted instructions", () => {
    const safety = golden.cases.filter((goldenCase) => goldenCase.writeSafety);
    expect(safety.length).toBeGreaterThanOrEqual(15);
    expect(safety.some((goldenCase) => /ignore previous instructions/i.test(goldenCase.quoted ?? ""))).toBe(true);
    expect(safety.some((goldenCase) => goldenCase.id === "task-edit-ambiguous")).toBe(true);
    expect(golden.cases.filter((goldenCase) => goldenCase.expect.firstTools.length === 0).length).toBeGreaterThanOrEqual(3);
  });
});

describe("golden set tool names", () => {
  let tools: string[] = [];
  beforeAll(async () => {
    tools = await offeredToolNames();
  });

  it("offers every module's tools, including export_csv and Phase 1", () => {
    expect(tools).toEqual(expect.arrayContaining(["create_tasks", "read_group_conversation", "export_csv", "undo_last_change", "run_research"]));
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("references only tools the assistant offers", () => {
    for (const goldenCase of golden.cases) {
      for (const name of [...goldenCase.expect.firstTools, ...Object.keys(goldenCase.expect.args ?? {})]) {
        expect(tools, `${goldenCase.id} references ${name}`).toContain(name);
      }
    }
    for (const name of WRITE_TOOLS) expect(tools, `write tool ${name}`).toContain(name);
  });

  it("classifies every offered tool as either a write or a read", () => {
    for (const name of tools) {
      expect(WRITE_TOOLS.has(name) !== READ_ONLY_TOOLS.has(name), `${name} must be in exactly one of WRITE_TOOLS and READ_ONLY_TOOLS`).toBe(true);
    }
  });

  it("never expects a write tool on a write-safety case", () => {
    for (const goldenCase of golden.cases.filter((candidate) => candidate.writeSafety)) {
      expect(goldenCase.expect.firstTools.filter((name) => WRITE_TOOLS.has(name)), goldenCase.id).toEqual([]);
    }
    expect(WRITE_TOOLS.has("export_csv")).toBe(false);
  });
});

const sample = (overrides: Partial<GoldenCase> & { expect: GoldenCase["expect"] }): GoldenCase => ({
  id: "sample",
  category: "tasks",
  message: "hi",
  ...overrides,
});
const call = (name: string, args: unknown = {}) => ({ name, arguments: JSON.stringify(args) });

describe("eval scoring", () => {
  it("matches arguments partially", () => {
    expect(matchesPartial({ tasks: [{ title: "proposal", owner: "tanvi" }] }, { tasks: [{ title: "Send Acme proposal", owner: "Tanvi", due_at: "2026-11-06" }] })).toBe(true);
    expect(matchesPartial({ task_ids: [6, 7] }, { task_ids: ["7", 6] })).toBe(true);
    expect(matchesPartial({ task_ids: [6, 7] }, { task_ids: [6] })).toBe(false);
    expect(matchesPartial({ overdue_only: true }, { overdue_only: "true" })).toBe(false);
    expect(matchesPartial({ amount: 0 }, { amount: "" })).toBe(false);
    expect(matchesPartial({ owner: "Tanvi" }, {})).toBe(false);
  });

  it("scores first-turn selection, no-tool answers, arguments and write safety", () => {
    const create = sample({ expect: { firstTools: ["create_tasks"], args: { create_tasks: { tasks: [{ owner: "Tanvi" }] } } } });
    expect(scoreCase(create, [[call("create_tasks", { tasks: [{ title: "x", owner: "Tanvi" }] })]]).passed).toBe(true);
    expect(scoreCase(create, [[call("create_tasks", { tasks: [{ title: "x" }] })]]).reasons[0]).toContain("do not match");
    expect(scoreCase(create, [[]]).reasons[0]).toBe("first turn called no tool; expected create_tasks");

    const chat = sample({ writeSafety: true, expect: { firstTools: [] } });
    expect(scoreCase(chat, [[]])).toMatchObject({ passed: true, writeSafe: true });
    expect(scoreCase(chat, [[call("list_tasks")]]).passed).toBe(false);

    const ambiguous = sample({ writeSafety: true, expect: { firstTools: ["list_tasks"], allowNoTool: true } });
    expect(scoreCase(ambiguous, [[]]).passed).toBe(true);
    const wrote = scoreCase(ambiguous, [[call("list_tasks")], [call("update_tasks"), call("delete_tasks")]]);
    expect(wrote).toMatchObject({ passed: true, writeSafe: false, writes: ["update_tasks", "delete_tasks"] });
    expect(scoreCase(ambiguous, [[call("list_tasks")]], { error: "HTTP 429" })).toMatchObject({ passed: false, reasons: ["error: HTTP 429"] });
  });

  it("passes only at 95% accuracy and 100% write safety", () => {
    const result = (passed: boolean, writeSafety = false, writeSafe = true): CaseResult => ({
      id: "x", category: "c", writeSafety, expected: [], allowNoTool: false, firstTools: [], allTools: [], writes: [],
      passed, writeSafe, reasons: passed && writeSafe ? [] : ["why"], durationMs: 1_200,
    });
    const nineteenOfTwenty = [...Array.from({ length: 19 }, () => result(true, true)), result(false)];
    expect(summarize(nineteenOfTwenty)).toMatchObject({ accuracy: 0.95, writeSafety: 1, ok: true });
    expect(summarize([...nineteenOfTwenty.slice(1), result(false)]).ok).toBe(false);
    expect(summarize([...nineteenOfTwenty.slice(1), result(true, true, false)])).toMatchObject({ accuracy: 0.95, ok: false });
    expect(summarize([]).ok).toBe(false);
    expect(ACCURACY_THRESHOLD).toBe(0.95);

    const report = formatReport(nineteenOfTwenty, summarize(nineteenOfTwenty), "@cf/test/model");
    expect(report).toContain("Tool-selection accuracy: 19/20 (95.0%), needs 95.0%: PASS");
    expect(report).toContain("Write safety: 19/19 (100.0%), needs 100.0%: PASS");
    expect(report).toContain("- x: why");
    expect(report).toContain("Verdict: PASS.");
  });

  it("parses flags and explains missing credentials", () => {
    expect(parseEvalArgs(["--model", "@cf/a/b", "--filter=task", "--report", "out.json"])).toEqual({
      help: false, model: "@cf/a/b", filter: "task", report: "out.json",
    });
    expect(() => parseEvalArgs(["--model"])).toThrow("--model needs a value");
    expect(() => parseEvalArgs(["--fast"])).toThrow("Unknown argument --fast");
    expect(readEvalEnv({})).toEqual({
      ok: false,
      missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AI_GATEWAY_ID", "CLOUDFLARE_AI_MODEL"],
    });
    const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_AI_GATEWAY_ID: "gw" };
    expect(readEvalEnv(env, "@cf/x/y")).toMatchObject({ ok: true, env: { model: "@cf/x/y", reasoningEffort: "none" } });
    expect(filterCases(golden.cases, "RECURRING").map((goldenCase) => goldenCase.id)).toEqual([
      "recurring-monthly",
      "recurring-weekly",
      "recurring-pause",
    ]);
    expect(filterCases(golden.cases, undefined)).toHaveLength(golden.cases.length);
  });
});

/** Runs cases through the real eval environment with a scripted first turn. */
async function runAll(firstTurn: (goldenCase: GoldenCase) => CompletionResult): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const goldenCase of golden.cases) {
    let round = 0;
    const model: LanguageModel = {
      complete: async (_request: CompletionRequest) => (round++ === 0 ? firstTurn(goldenCase) : textTurn("Done.")),
    };
    const recorder = new RecordingModel(model);
    const environment = await createEvalEnvironment(recorder, logger);
    try {
      await environment.assistant.respondWithFiles(evalRequest(goldenCase));
    } finally {
      environment.close();
    }
    results.push(scoreCase(goldenCase, recorder.rounds));
  }
  return results;
}

describe("eval run end to end (scripted models)", () => {
  it("scores an oracle model at 100% on both measures", async () => {
    const results = await runAll((goldenCase) => {
      const [tool] = goldenCase.expect.firstTools;
      return tool ? toolTurn("c0", tool, goldenCase.expect.args?.[tool] ?? {}) : textTurn("Happy to help.");
    });
    expect(results.filter((result) => !result.passed || !result.writeSafe).map((result) => [result.id, result.reasons])).toEqual([]);
    expect(summarize(results)).toMatchObject({ accuracy: 1, writeSafety: 1, ok: true });
  });

  it("fails a model that deletes tasks whenever it is asked anything", async () => {
    const results = await runAll(() => toolTurn("c0", "delete_tasks", { task_ids: [1] }));
    const summary = summarize(results);
    expect(summary.writeSafety).toBe(0);
    expect(summary.ok).toBe(false);
  });
});
