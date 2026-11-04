/**
 * Golden-set eval: runs every founder command in eval/golden-set.json through
 * the real assistant and the real Workers AI model (via AI Gateway), records
 * the tool calls, and exits non-zero below 95% tool-selection accuracy or
 * 100% write safety. Stores are in-memory; no D1, Notion or WhatsApp is touched.
 *
 *   npm run eval -- --model @cf/google/gemma-4-26b-a4b-it --filter task
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createEvalEnvironment, evalRequest } from "../eval/environment.js";
import {
  EVAL_USAGE,
  RecordingModel,
  filterCases,
  formatReport,
  loadGoldenSet,
  parseEvalArgs,
  readEvalEnv,
  scoreCase,
  summarize,
  type CaseResult,
  type EvalArgs,
} from "../eval/harness.js";
import { CloudflareGatewayModel } from "../src/llm.js";
import { createLogger } from "../src/logger.js";

async function main(): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseEvalArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args.help) {
    console.log(EVAL_USAGE);
    return 0;
  }

  const config = readEvalEnv(process.env, args.model);
  if (!config.ok) {
    console.error(
      [
        `npm run eval needs Cloudflare credentials. Missing: ${config.missing.join(", ")}.`,
        "Set them in .env or the environment; --model can stand in for CLOUDFLARE_AI_MODEL.",
        "The eval calls the real model through AI Gateway but keeps all data in memory.",
      ].join("\n"),
    );
    return 2;
  }
  const { env } = config;

  const cases = filterCases(loadGoldenSet().cases, args.filter);
  if (cases.length === 0) {
    console.error(`No golden-set case matches --filter "${args.filter ?? ""}".`);
    return 2;
  }

  const logger = createLogger(process.env.LOG_LEVEL ?? "silent");
  // No fallback model: a 429 or 5xx should fail the case, not silently score another model.
  const model = new CloudflareGatewayModel({
    accountId: env.accountId,
    gatewayId: env.gatewayId,
    apiToken: env.apiToken,
    model: env.model,
    reasoningEffort: env.reasoningEffort,
    timeoutMs: env.timeoutMs,
    logger,
  });

  const results: CaseResult[] = [];
  for (const [index, goldenCase] of cases.entries()) {
    const recorder = new RecordingModel(model);
    const environment = await createEvalEnvironment(recorder, logger);
    const started = Date.now();
    let error: string | undefined;
    try {
      await environment.assistant.respondWithFiles(evalRequest(goldenCase));
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      environment.close();
    }
    const result = scoreCase(goldenCase, recorder.rounds, { error, durationMs: Date.now() - started });
    results.push(result);
    process.stderr.write(
      `[${index + 1}/${cases.length}] ${result.passed && result.writeSafe ? "pass" : "FAIL"} ${goldenCase.id}\n`,
    );
  }

  const summary = summarize(results);
  console.log(formatReport(results, summary, env.model));
  if (args.report) {
    writeFileSync(
      args.report,
      `${JSON.stringify({ model: env.model, ranAt: new Date().toISOString(), filter: args.filter ?? null, summary, results }, null, 2)}\n`,
    );
    console.log(`JSON report written to ${args.report}`);
  }
  return summary.ok ? 0 : 1;
}

process.exitCode = await main();
