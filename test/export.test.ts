import { EventEmitter } from "node:events";
import whatsapp from "whatsapp-web.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPORT_MAX_ROWS,
  ExportRegistry,
  ExportTools,
  exportFileName,
  isExportRequest,
  type ExportSource,
} from "../src/assistant-export.js";
import { DiaAssistant } from "../src/assistant.js";
import { WhatsAppBot } from "../src/bot.js";
import { ChecklistStore } from "../src/checklist-store.js";
import { ContextBuffer } from "../src/context-buffer.js";
import { toCsv, toCsvBuffer } from "../src/csv.js";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "../src/d1-schema.js";
import { coreExportSources, localStamp } from "../src/export-sources.js";
import { FollowUpStore } from "../src/follow-up-store.js";
import type { CompletionRequest, CompletionResult } from "../src/llm.js";
import { TaskStore, type TaskCreateInput } from "../src/task-store.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const NOW = new Date("2026-11-04T06:30:00.000Z"); // Wednesday 12:00 IST
const BOM = "﻿";

describe("toCsv", () => {
  it("writes RFC 4180 CSV with a BOM, CRLF line breaks and a trailing CRLF", () => {
    expect(toCsv(["a", "b"], [["1", "2"]])).toBe(`${BOM}a,b\r\n1,2\r\n`);
    expect(toCsv(["a"], [], { bom: false })).toBe("a\r\n");
  });

  it("quotes commas, double quotes and embedded line breaks", () => {
    const csv = toCsv(
      ["Title", "Notes"],
      [
        ["Pay GST, TDS", 'Ask the CA "today"'],
        ["Multi-line", "first line\nsecond line\r\nthird"],
        ["plain", "no quoting needed"],
      ],
      { bom: false },
    );
    expect(csv).toBe(
      [
        "Title,Notes",
        '"Pay GST, TDS","Ask the CA ""today"""',
        'Multi-line,"first line\nsecond line\r\nthird"',
        "plain,no quoting needed",
        "",
      ].join("\r\n"),
    );
  });

  it("renders empty, numeric and boolean cells and pads rows to the header width", () => {
    expect(toCsv(["a", "b", "c", "d"], [[null, 1250.5, true], ["x", undefined, false, "y", "dropped"]], { bom: false })).toBe(
      "a,b,c,d\r\n,1250.5,true,\r\nx,,false,y\r\n",
    );
    expect(toCsv(["n"], [[Number.NaN]], { bom: false })).toBe("n\r\n\r\n");
  });

  it("neutralizes formulas in text cells but not in numbers or the header", () => {
    const rows = [["=HYPERLINK(\"http://x\")"], ["+91 98"], ["-5% discount"], ["@SUM(A1)"], [-5], ["safe"]];
    expect(toCsv(["=Header"], rows, { bom: false })).toBe(
      ['=Header', `"'=HYPERLINK(""http://x"")"`, "'+91 98", "'-5% discount", "'@SUM(A1)", "-5", "safe", ""].join("\r\n"),
    );
    expect(toCsv(["h"], [["=1+1"]], { bom: false, guardFormulas: false })).toBe("h\r\n=1+1\r\n");
  });

  it("encodes UTF-8 with the BOM bytes so Excel shows ₹ correctly", () => {
    const buffer = toCsvBuffer(["Amount"], [["₹4,200"]]);
    expect([...buffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buffer.toString("utf8")).toBe(`${BOM}Amount\r\n"₹4,200"\r\n`);
  });
});

describe("export helpers", () => {
  it("detects export requests", () => {
    expect(isExportRequest("export all open tasks")).toBe(true);
    expect(isExportRequest("send me a CSV of follow-ups")).toBe(true);
    expect(isExportRequest("can I get this as an Excel sheet?")).toBe(true);
    expect(isExportRequest("what tasks are due today?")).toBe(false);
  });

  it("names files by label and the group's local date", () => {
    expect(exportFileName("open tasks for Tanvi", NOW, "Asia/Kolkata")).toBe("patch-open-tasks-for-tanvi-2026-11-04.csv");
    expect(exportFileName("checklist of #8 Incorporation docs", new Date("2026-11-04T20:00:00Z"), "Asia/Kolkata")).toBe(
      "patch-checklist-of-8-incorporation-docs-2026-11-05.csv",
    );
    expect(exportFileName("₹₹", NOW, "Asia/Kolkata")).toBe("patch-export-2026-11-04.csv");
  });

  it("formats timestamps in the group's timezone", () => {
    expect(localStamp("2026-11-04T06:30:00.000Z", "Asia/Kolkata")).toBe("2026-11-04 12:00");
    expect(localStamp(null, "Asia/Kolkata")).toBeNull();
  });
});

const fakeSource = (name: string, extra: Partial<ExportSource> = {}): ExportSource => ({
  name,
  description: `the ${name} dataset.`,
  load: async () => ({ label: name, columns: ["Name"], rows: [[name]], truncated: false }),
  ...extra,
});

describe("ExportRegistry", () => {
  it("rejects duplicate and malformed dataset names", () => {
    const registry = new ExportRegistry().register(fakeSource("tasks"));
    expect(() => registry.register(fakeSource("tasks"))).toThrow("already registered");
    expect(() => registry.register(fakeSource("Bad Name"))).toThrow("lower_snake_case");
    expect(registry.names).toEqual(["tasks"]);
  });

  it("rebuilds export_csv when a module registers a dataset later, keeping the first filter definition", () => {
    const tools = new ExportTools([], "Asia/Kolkata", logger);
    expect(tools.tools).toEqual([]);
    expect(tools.detect("export tasks")).toBe(false);
    tools.registry.register(
      fakeSource("spends", { filters: { owner: { type: "string", description: "first" } } }),
      fakeSource("metrics", { filters: { owner: { type: "string", description: "second" }, metric: { type: "string" } } }),
    );
    const [tool] = tools.tools;
    expect(tool?.name).toBe("export_csv");
    expect(tool?.parameters).toMatchObject({
      required: ["dataset"],
      properties: {
        dataset: { enum: ["spends", "metrics"] },
        owner: { description: "first" },
        metric: { type: "string" },
        limit: { maximum: EXPORT_MAX_ROWS },
      },
    });
    expect(tool?.description).toContain("Dataset metrics: the metrics dataset.");
    expect(tools.detect("export metrics")).toBe(true);
  });
});

let executor: ReturnType<typeof createSqliteExecutor> | undefined;
afterEach(() => {
  executor?.close();
  executor = undefined;
});

function draft(title: string, extra: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return { title, notes: null, status: null, priority: null, owner: null, area: null, dueAt: null, tags: [], ...extra };
}

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

function setup(llm: ReturnType<typeof scripted>) {
  executor = createSqliteExecutor();
  const clock = () => NOW;
  const phase1Schema = new SchemaGate(executor, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
  const tasks = new TaskStore({ db: executor, timezone: "Asia/Kolkata", logger, now: clock });
  const followUps = new FollowUpStore({ db: executor, schema: phase1Schema, timezone: "Asia/Kolkata", logger, now: clock });
  const checklists = new ChecklistStore({ db: executor, schema: phase1Schema, logger, now: clock });
  const exportTools = new ExportTools(
    coreExportSources({ db: executor, tasks, phase1Schema, checklists }),
    "Asia/Kolkata",
    logger,
    clock,
  );
  const assistant = new DiaAssistant({
    llm,
    botName: "Patch",
    timezone: "Asia/Kolkata",
    tasks,
    modules: [exportTools],
    checklists,
    logger,
  });
  return { tasks, followUps, checklists, exportTools, assistant };
}

const request = (body: string) => ({
  groupId: "g1",
  groupName: "HQ",
  messageId: "msg",
  requestedBy: "Tanvi",
  requestedById: "t@c.us",
  body,
  quotedMessage: null,
  recentContext: [],
});

const source = { actor: "Sagnik", groupName: "HQ", messageId: "m1" };
const csvLines = (data: Buffer) => data.toString("utf8").replace(BOM, "").split("\r\n");

describe("export_csv through the assistant", () => {
  it("exports open tasks as a CSV file attached to a deterministic confirmation", async () => {
    const llm = scripted(toolTurn("e1", "export_csv", { dataset: "tasks" }));
    const { tasks, assistant } = setup(llm);
    await tasks.create(
      [
        draft("Pay GST, TDS", { owner: "Tanvi", dueAt: "2026-11-06", priority: "high", tags: ["finance"], notes: 'Ask CA "today"\nthen pay ₹4,200' }),
        draft("Renew domain", { owner: "Sagnik" }),
        draft("Old done task", { status: "done" }),
      ],
      source,
    );

    const reply = await assistant.respondWithFiles(request("@patch export open tasks as CSV"));

    expect(llm.requests[0]?.toolChoice).toBe("required");
    expect(llm.complete).toHaveBeenCalledOnce();
    expect(reply.text).toBe("📎 Exported 2 rows of open tasks as patch-open-tasks-2026-11-04.csv.");
    expect(reply.files).toHaveLength(1);
    const [file] = reply.files;
    expect(file).toMatchObject({ fileName: "patch-open-tasks-2026-11-04.csv", mimeType: "text/csv" });
    expect(file?.data.toString("utf8").startsWith(BOM)).toBe(true);
    expect(csvLines(file?.data ?? Buffer.alloc(0))).toEqual([
      "ID,Title,Status,Priority,Owner,Area,Due,Tags,Notes,Created by,Created,Updated,Completed",
      '1,"Pay GST, TDS",todo,high,Tanvi,,2026-11-06,finance,"Ask CA ""today""\nthen pay ₹4,200",Sagnik,2026-11-04 12:00,2026-11-04 12:00,',
      "2,Renew domain,todo,,Sagnik,,,,,Sagnik,2026-11-04 12:00,2026-11-04 12:00,",
      "",
    ]);
  });

  it("bounds the row count, says when rows were left out, and respond() keeps returning text", async () => {
    const llm = scripted(
      toolTurn("e1", "export_csv", { dataset: "tasks", include_closed: true, owner: "me", limit: 2 }),
    );
    const { tasks, assistant } = setup(llm);
    await tasks.create(
      [draft("A", { owner: "Tanvi" }), draft("B", { owner: "tanvi", status: "done" }), draft("C", { owner: "Tanvi" }), draft("D")],
      source,
    );

    const text = await assistant.respond(request("@patch export all my tasks"));

    expect(text).toBe(
      "📎 Exported 2 rows of all tasks for Tanvi as patch-all-tasks-for-tanvi-2026-11-04.csv.\n⚠️ Only the first 2 rows are included; narrow the filters for the rest.",
    );
  });

  it("exports follow-ups and a task's checklist in one reply", async () => {
    const llm = scripted(
      toolTurn("f", "export_csv", { dataset: "follow_ups" }, ["c", "export_csv", { dataset: "checklist", task_id: 1 }]),
    );
    const { tasks, followUps, checklists, assistant } = setup(llm);
    await followUps.create(
      [{ owner: "Sagnik", counterparty: "Rahul (Acme)", promise: "Send the DPA", dueAt: "2026-11-06", notes: null }],
      source,
    );
    await tasks.create([draft("Incorporation docs")], source);
    await checklists.add(1, ["PAN", "GST cert"], "Sagnik");
    await checklists.setDone(1, [1], true, "Sagnik");

    const reply = await assistant.respondWithFiles(request("@patch export follow-ups and the checklist on #1"));

    expect(reply.text).toBe(
      [
        "📎 Exported 1 row of open follow-ups as patch-open-follow-ups-2026-11-04.csv.",
        "📎 Exported 2 rows of checklist of #1 Incorporation docs as patch-checklist-of-1-incorporation-docs-2026-11-04.csv.",
      ].join("\n"),
    );
    expect(reply.files.map((file) => csvLines(file.data))).toEqual([
      [
        "Ref,Owner,Counterparty,Promise,Status,Due,Notes,Created by,Created,Closed",
        "F1,Sagnik,Rahul (Acme),Send the DPA,open,2026-11-06,,Sagnik,2026-11-04 12:00,",
        "",
      ],
      ["Task ID,Task,Item,Text,Done", "1,Incorporation docs,1,PAN,yes", "1,Incorporation docs,2,GST cert,no", ""],
    ]);
  });

  it("sends errors back to the model and attaches nothing for an empty export", async () => {
    const llm = scripted(
      toolTurn("x", "export_csv", { dataset: "spends" }),
      toolTurn("y", "export_csv", { dataset: "checklist" }),
      toolTurn("z", "export_csv", { dataset: "tasks", statuses: ["Blocked"] }),
    );
    const { assistant } = setup(llm);

    const reply = await assistant.respondWithFiles(request("@patch export blocked tasks"));

    expect(reply).toEqual({ text: "📭 Nothing to export for blocked tasks.", files: [] });
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("Unknown dataset");
    expect(JSON.stringify(llm.requests[2]?.messages)).toContain("needs task_id");
  });

  it("attaches at most three files to one reply", async () => {
    const call = (id: string): [string, string, unknown] => [id, "export_csv", { dataset: "tasks" }];
    const llm = scripted(
      toolTurn("a", "export_csv", { dataset: "tasks" }, call("b"), call("c"), call("d")),
      textTurn("Sent three files."),
    );
    const { tasks, assistant } = setup(llm);
    await tasks.create([draft("Only task")], source);

    const reply = await assistant.respondWithFiles(request("@patch export tasks four times"));

    expect(reply.files).toHaveLength(3);
    expect(reply.text.endsWith("Sent three files.")).toBe(true);
    expect(JSON.stringify(llm.requests[1]?.messages)).toContain("Only 3 files");
  });
});

class FakeClient extends EventEmitter {
  public readonly info = { wid: { _serialized: "91900@c.us" } };
  public readonly initialize = vi.fn(async () => {
    this.emit("authenticated");
    this.emit("ready");
  });
  public readonly destroy = vi.fn(async () => undefined);
  public readonly getChats = vi.fn(async () => []);
  private sent = 0;
  public readonly sendMessage = vi.fn(async (_chatId: string, _content: unknown, _options?: unknown) => ({
    id: { _serialized: `out-${(this.sent += 1)}` },
  }));
}

function incoming(body: string) {
  return {
    from: "hq@g.us",
    to: "91900@c.us",
    fromMe: false,
    author: "sagnik@c.us",
    body,
    type: "chat",
    timestamp: 1_793_000_000,
    mentionedIds: [],
    hasMedia: false,
    hasQuotedMsg: false,
    id: { _serialized: "in-1" },
    getContact: async () => ({ pushname: "Sagnik", id: { _serialized: "sagnik@c.us" }, number: "91800" }),
    getChat: async () => ({ name: "Autter HQ" }),
  };
}

async function deliver(respondWithFiles: ReturnType<typeof vi.fn>) {
  const client = new FakeClient();
  const record = vi.fn();
  const bot = new WhatsAppBot({
    assistant: { respondWithFiles } as never,
    context: new ContextBuffer(5),
    dedupe: { claim: () => true } as never,
    allowedGroupIds: new Set(),
    authorizedUserIds: new Set(["sagnik@c.us"]),
    unauthorizedReply: "No.",
    botName: "Patch",
    botTrigger: "@patch",
    dataDir: ".data",
    listGroupsOnStart: false,
    conversation: { record },
    client: client as never,
    logger,
  });
  await bot.start();
  client.emit("message_create", incoming("@patch export open tasks"));
  await vi.waitFor(() => expect(respondWithFiles).toHaveBeenCalledOnce());
  return { client, record };
}

describe("WhatsAppBot file delivery", () => {
  const csv = toCsvBuffer(["ID", "Title"], [[1, "Pay GST"]]);

  it("sends the reply text, then each file as a document, and logs it", async () => {
    const respondWithFiles = vi.fn().mockResolvedValue({
      text: "📎 Exported 1 row of open tasks as patch-open-tasks-2026-11-04.csv.",
      files: [{ fileName: "patch-open-tasks-2026-11-04.csv", mimeType: "text/csv", data: csv }],
    });
    const { client, record } = await deliver(respondWithFiles);
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(2));

    expect(respondWithFiles.mock.calls[0]?.[0]).toMatchObject({ body: "export open tasks", requestedBy: "Sagnik" });
    expect(client.sendMessage.mock.calls[0]).toEqual([
      "hq@g.us",
      "📎 Exported 1 row of open tasks as patch-open-tasks-2026-11-04.csv.",
    ]);
    const [chatId, media, options] = client.sendMessage.mock.calls[1] ?? [];
    expect(chatId).toBe("hq@g.us");
    expect(media).toBeInstanceOf(whatsapp.MessageMedia);
    expect(media).toMatchObject({
      mimetype: "text/csv",
      filename: "patch-open-tasks-2026-11-04.csv",
      filesize: csv.length,
    });
    expect(Buffer.from((media as { data: string }).data, "base64").equals(csv)).toBe(true);
    expect(options).toEqual({ sendMediaAsDocument: true });
    expect(record.mock.calls.map(([entry]) => [entry.messageId, entry.body, entry.fromBot])).toEqual([
      ["in-1", "@patch export open tasks", false],
      ["out-1", "📎 Exported 1 row of open tasks as patch-open-tasks-2026-11-04.csv.", true],
      ["out-2", "[document] patch-open-tasks-2026-11-04.csv", true],
    ]);
  });

  it("tells the group when a document fails to send instead of dropping it silently", async () => {
    const respondWithFiles = vi.fn().mockResolvedValue({
      text: "📎 Exported.",
      files: [{ fileName: "patch-tasks.csv", mimeType: "text/csv", data: csv }],
    });
    const client = new FakeClient();
    client.sendMessage
      .mockResolvedValueOnce({ id: { _serialized: "out-1" } })
      .mockRejectedValueOnce(new Error("upload failed"));
    const bot = new WhatsAppBot({
      assistant: { respondWithFiles } as never,
      context: new ContextBuffer(5),
      dedupe: { claim: () => true } as never,
      allowedGroupIds: new Set(),
      authorizedUserIds: new Set(["sagnik@c.us"]),
      unauthorizedReply: "No.",
      botName: "Patch",
      botTrigger: "@patch",
      dataDir: ".data",
      listGroupsOnStart: false,
      client: client as never,
      logger,
    });
    await bot.start();
    client.emit("message_create", incoming("@patch export tasks"));

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(3));
    expect(client.sendMessage.mock.calls[2]).toEqual(["hq@g.us", "⚠️ I couldn't attach patch-tasks.csv. Please ask again."]);
  });
});
