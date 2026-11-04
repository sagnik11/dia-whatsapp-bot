import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceTools, isProfileDeletionRequest, isVoiceRequest } from "../src/assistant-voice.js";
import { DiaAssistant } from "../src/assistant.js";
import { WhatsAppBot } from "../src/bot.js";
import { ConversationStore } from "../src/conversation-store.js";
import { PHASE1_SCHEMA_STATEMENTS, SchemaGate } from "../src/d1-schema.js";
import type { CompletionRequest, CompletionResult, LanguageModel } from "../src/llm.js";
import { PEOPLE_SCHEMA_STATEMENTS, PeopleStore } from "../src/people-store.js";
import { SetupInterview, parseSetupQuestion, setupCommand } from "../src/setup-interview.js";
import type { SetupQuestion } from "../src/setup-questions.js";
import { SETUP_QUESTIONS } from "../src/setup-questions.js";
import { TaskStore } from "../src/task-store.js";
import type { AssistantAttachment, AssistantRequest } from "../src/types.js";
import { VoiceLearningJob } from "../src/voice.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";
import { createSqliteExecutor } from "./support/sqlite-executor.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function store() {
  const db = createSqliteExecutor();
  cleanups.push(() => db.close());
  // audit_events lives in the Phase 1 schema.
  const phase1 = new SchemaGate(db, PHASE1_SCHEMA_STATEMENTS, logger, "Phase 1");
  const people = new PeopleStore({ db, schema: new SchemaGate(db, PEOPLE_SCHEMA_STATEMENTS, logger, "People"), logger });
  return { db, phase1, people };
}

/** A model that answers background calls by feature, and fails loudly on anything else. */
function featureModel(replies: Record<string, (request: CompletionRequest) => string>) {
  const requests: CompletionRequest[] = [];
  const llm: LanguageModel = {
    complete: vi.fn(async (request: CompletionRequest): Promise<CompletionResult> => {
      requests.push(request);
      const feature = request.metadata?.feature ?? "";
      const reply = replies[feature];
      if (!reply) throw new Error(`unexpected model call: ${feature}`);
      return textTurn(reply(request));
    }),
  };
  return { llm, requests };
}

const SAGNIK_IDS = ["111@lid", "9198@c.us"];

function request(body: string, extra: Partial<AssistantRequest> = {}): AssistantRequest {
  return {
    groupId: "g1@g.us",
    groupName: "HQ",
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    requestedBy: "Sagnik",
    requestedById: "111@lid",
    body,
    quotedMessage: null,
    recentContext: [],
    ...extra,
  };
}

const QUESTIONS: readonly SetupQuestion[] = [
  { key: "role", section: "You", text: "What's your role?", kind: "answer", probe: true, profileField: "role" },
  { key: "signoff", section: "How you write", text: "How do you sign off?", kind: "answer", probe: false },
  { key: "sample_investor", section: "Samples", text: "Paste an investor email.", kind: "sample", probe: false },
];

describe("setup commands and question markers", () => {
  it("recognises setup commands and nothing else", () => {
    expect(setupCommand("setup")).toBe("start");
    expect(setupCommand("@919876 run setup please")).toBe("start");
    expect(setupCommand("Set me up!")).toBe("start");
    expect(setupCommand("setup again")).toBe("restart");
    expect(setupCommand("redo my setup")).toBe("restart");
    expect(setupCommand("pause setup")).toBe("pause");
    expect(setupCommand("skip")).toBe("skip");
    expect(setupCommand("back")).toBe("back");
    expect(setupCommand("that's all")).toBe("finish");
    expect(setupCommand("set up a call with Rahul")).toBeNull();
    expect(setupCommand("Hey Rahul, quick one")).toBeNull();
  });

  it("reads the person and number from a question", () => {
    expect(parseSetupQuestion("📝 Setup · Tanvi Sharma · Q7/22 · follow-up\n\nWhat?")).toEqual({ name: "Tanvi Sharma", number: 7 });
    expect(parseSetupQuestion("✅ Task #7 added")).toBeNull();
    expect(parseSetupQuestion(null)).toBeNull();
  });

  it("asks a full interview of 20+ questions with unique keys", () => {
    expect(SETUP_QUESTIONS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SETUP_QUESTIONS.map((question) => question.key)).size).toBe(SETUP_QUESTIONS.length);
    expect(SETUP_QUESTIONS.filter((question) => question.kind === "sample").length).toBeGreaterThanOrEqual(3);
  });
});

describe("PeopleStore", () => {
  it("matches the checked-in D1 migration", () => {
    const migration = readFileSync(new URL("../migrations/0008_people.sql", import.meta.url), "utf8");
    const statements = migration
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual(PEOPLE_SCHEMA_STATEMENTS.map((s) => s.replace(/\s+/g, " ").trim()));
  });

  it("finds a person by any sender id or by first name, and remembers a new WhatsApp name", async () => {
    const { people } = store();
    const created = await people.ensure({ name: "Sagnik Ghosh", senderIds: SAGNIK_IDS });
    expect((await people.findBySender(["9198@c.us"]))?.id).toBe(created.id);
    const again = await people.ensure({ name: "Sags", senderIds: ["9198@c.us", "new@lid"] });
    expect(again.id).toBe(created.id);
    expect(again.aliases).toEqual(["Sags"]);
    expect((await people.findBySender(["new@lid"]))?.id).toBe(created.id);
    expect((await people.findByName("sagnik"))?.id).toBe(created.id);
    expect((await people.findByName("SAGS"))?.id).toBe(created.id);
    expect(await people.findByName("Tanvi")).toBeNull();
  });

  it("removes only the owner's rules, and erases everything on delete", async () => {
    const { people } = store();
    const sagnik = await people.ensure({ name: "Sagnik", senderIds: ["s@c.us"] });
    const tanvi = await people.ensure({ name: "Tanvi", senderIds: ["t@c.us"] });
    const rule = await people.addNote(tanvi.id, { kind: "rule", topic: null, content: "Never say Dear", sourceMessageId: null });
    expect(await people.deleteRules(sagnik.id, [rule.id], "Sagnik")).toEqual([]);
    expect(await people.notes(tanvi.id)).toHaveLength(1);
    await people.remove(tanvi.id, "Tanvi");
    expect(await people.findBySender(["t@c.us"])).toBeNull();
    expect(await people.notes(tanvi.id)).toEqual([]);
  });
});

describe("@patch setup interview", () => {
  function interview(options: { followUp?: string | null } = {}) {
    const { people } = store();
    const model = featureModel({
      setup_follow_up: () => JSON.stringify({ followUp: options.followUp ?? null }),
      setup_screenshot: () => "Hi Asha,\nQuick update on our seed round.\nCheers, S",
      voice_synthesis: () => JSON.stringify({ summary: "Sagnik runs product.", voice: "- Opens with 'Hey <name>'\n- Signs off 'Cheers, S'" }),
    });
    const setup = new SetupInterview({ people, llm: model.llm, logger, questions: QUESTIONS });
    const say = (body: string, quotedSetup: { name: string; number: number } | null = null, extra: Partial<AssistantRequest> = {}) =>
      setup.handle({ request: request(body, extra), senderIds: SAGNIK_IDS, quotedSetup });
    return { people, model, setup, say };
  }

  it("walks one person through every question, saving answers, follow-ups and samples", async () => {
    const { people, model, say } = interview({ followUp: "Which parts of product do you own yourself? An example helps." });

    const first = await say("setup");
    expect(first).toContain("👋 Let's set you up, Sagnik. 3 short questions");
    expect(first).toContain("📝 Setup · Sagnik · Q1/3\n\n*You*\nWhat's your role?");

    // A probe question gets one follow-up, then moves on.
    const followUp = await say("Cofounder, I do product", { name: "Sagnik", number: 1 });
    expect(followUp).toContain("Q1/3 · follow-up\n\nWhich parts of product do you own yourself?");
    expect(await say("Roadmap and the merge gate engine", { name: "Sagnik", number: 1 })).toContain("Q2/3\n\n*How you write*\nHow do you sign off?");

    // An answer straight after @patch also counts.
    expect(await say("Cheers, S")).toContain("Q3/3");
    // A screenshot answer is read by the model and kept as a sample.
    const image: AssistantAttachment = { kind: "image", mimeType: "image/png", fileName: "mail.png", dataBase64: "aGk=", sizeBytes: 2, transcript: null };
    const done = await say("", { name: "Sagnik", number: 3 }, { attachments: [image] });
    expect(done).toContain("✅ Setup done, Sagnik.");
    expect(done).toContain("- Signs off 'Cheers, S'");

    const person = await people.findBySender(SAGNIK_IDS);
    expect(person).toMatchObject({ role: "Cofounder, I do product", about: "Sagnik runs product.", setup: { status: "done" } });
    const notes = await people.notes(person?.id ?? 0);
    expect(notes.map((note) => [note.kind, note.topic])).toEqual([
      ["answer", "role"],
      ["answer", "signoff"],
      ["sample", "sample_investor"],
    ]);
    expect(notes[0]?.content).toBe(
      "Cofounder, I do product\n\nFollow-up: Which parts of product do you own yourself? An example helps.\nRoadmap and the merge gate engine",
    );
    expect(notes[2]?.content).toBe("Hi Asha,\nQuick update on our seed round.\nCheers, S");
    const synthesis = model.requests.find((call) => call.metadata?.feature === "voice_synthesis");
    expect(String(synthesis?.messages[0]?.content)).toContain("Cheers, S");

    expect(await say("setup")).toContain("You've finished setup already");
    expect(await say("setup again")).toContain("Q1/3");
  });

  it("supports skip, back, pause and resume, and revising an earlier answer by replying to it", async () => {
    const { people, say } = interview();
    await say("setup");
    expect(await say("Product and engineering")).toContain("Q2/3");
    expect(await say("skip")).toContain("Q3/3");
    expect(await say("back")).toContain("Q2/3");
    expect(await say("pause setup")).toBe('⏸️ Paused at Q2 of 3. Everything so far is saved; send "@patch setup" to carry on.');
    // Paused: messages go to Patch as usual.
    expect(await say("Best, Sagnik")).toBeNull();
    expect(await say("setup")).toContain("Welcome back, Sagnik. Picking up where you left off.\n\n📝 Setup · Sagnik · Q2/3");
    const revised = await say("Founder; product, engineering and hiring", { name: "Sagnik", number: 1 });
    expect(revised).toContain("✏️ Updated your answer to Q1.");
    expect(revised).toContain("Q2/3");
    const person = await people.findBySender(SAGNIK_IDS);
    expect(person?.role).toBe("Founder; product, engineering and hiring");
  });

  it("leaves other people's replies and unrelated requests to Patch", async () => {
    const { say, setup } = interview();
    expect(await say("Cheers")).toBeNull(); // no session yet
    await say("setup");
    // Tanvi replying to Sagnik's question is not Sagnik's answer.
    expect(await setup.handle({ request: request("Best", { requestedBy: "Tanvi", requestedById: "t@c.us" }), senderIds: ["t@c.us"], quotedSetup: { name: "Sagnik", number: 1 } })).toBeNull();
    // A reply to Sagnik's question from someone with their own session but a different name is ignored too.
    expect(await say("anything", { name: "Tanvi", number: 1 })).toBeNull();
    // Mid-setup, an obvious request or a message quoting something else is handled normally.
    expect(await say("add a task to renew the domain")).toBeNull();
    expect(await say("what's this?", null, { quotedMessage: "Invoice from AWS" })).toBeNull();
    // A voice-note answer uses its transcript.
    expect(await say("", { name: "Sagnik", number: 1 }, { attachments: [{ kind: "audio", mimeType: "audio/ogg", fileName: "a.ogg", dataBase64: "", sizeBytes: 1, transcript: "I run product, basically." }] })).toContain("Q2/3");
  });
});

describe("drafting in each person's voice", () => {
  async function voiceFixture() {
    const { db, people } = store();
    const conversation = new ConversationStore(":memory:");
    cleanups.push(() => conversation.close());
    const sagnik = await people.ensure({ name: "Sagnik", senderIds: ["s@c.us"] });
    await people.setVoice(sagnik.id, "- Opens with 'Hey <name>'\n- Signs off 'Cheers, S'", "Product cofounder.");
    await people.addNote(sagnik.id, { kind: "sample", topic: "sample_investor", content: "Hey Asha, quick update on the round. Cheers, S", sourceMessageId: null });
    await people.addNote(sagnik.id, { kind: "sample", topic: "sample_customer", content: "Hey Rahul, pilot starts Monday. Cheers, S", sourceMessageId: null });
    const now = Date.now();
    await conversation.record({ groupId: "g1@g.us", messageId: "c1", author: "Tanvi", body: "haan done, sending the deck to Asha tonight 🙌", fromBot: false, sentAtMs: now - 60_000 });
    const voice = new VoiceTools({ people, conversation, logger });
    const tasks = new TaskStore({ db, timezone: "Asia/Kolkata", logger });
    return { db, people, conversation, voice, tasks, sagnik };
  }

  it("detects drafting, corrections and profile requests", () => {
    expect(isVoiceRequest("reply to this in my tone")).toBe(true);
    expect(isVoiceRequest("draft a polite nudge to our designer")).toBe(true);
    expect(isVoiceRequest("write this in Tanvi's voice")).toBe(true);
    expect(isVoiceRequest("too formal, try again")).toBe(true);
    expect(isVoiceRequest("show my profile")).toBe(true);
    expect(isVoiceRequest("sounds like a plan")).toBe(false);
    expect(isVoiceRequest("add a task to pay AWS")).toBe(false);
    expect(isProfileDeletionRequest("@patch delete my profile")).toBe(true);
    expect(isProfileDeletionRequest("what does my profile say?")).toBe(false);
  });

  it("gives the requester's voice, rules and audience-matched samples, and the model drafts from it", async () => {
    const { voice, tasks, people, sagnik } = await voiceFixture();
    await people.addNote(sagnik.id, { kind: "rule", topic: null, content: "Never write 'Dear'", sourceMessageId: null });
    const requests: CompletionRequest[] = [];
    const turns = [
      toolTurn("v1", "get_writing_voice", { audience: "customer" }),
      textTurn("Hey Rahul, Thursday works. DPA by Friday. Cheers, S"),
    ];
    const llm: LanguageModel = {
      complete: async (completion) => {
        requests.push({ ...completion, messages: [...completion.messages] });
        const next = turns.shift();
        if (!next) throw new Error("out of turns");
        return next;
      },
    };
    const bot = new DiaAssistant({ llm, botName: "Patch", timezone: "Asia/Kolkata", tasks, modules: [voice], logger });
    const reply = await bot.respond(request("reply to this in my tone", { requestedById: "s@c.us", quotedMessage: "Rahul: can we move kickoff to Thursday?" }));
    expect(reply).toBe("Hey Rahul, Thursday works. DPA by Friday. Cheers, S");
    expect(requests[0]?.toolChoice).toBe("required");
    expect(requests[0]?.system).toContain("never in Patch's harbour-master voice");
    const toolOutput = requests[1]?.messages.find((message) => message.role === "tool");
    const payload = JSON.parse(String(toolOutput?.content)) as Record<string, unknown> & { samples: Array<{ about: string }>; rules: Array<{ ref: string }> };
    expect(payload).toMatchObject({ found: true, person: "Sagnik", voice: "- Opens with 'Hey <name>'\n- Signs off 'Cheers, S'" });
    expect(payload.samples[0]?.about).toBe("sample_customer");
    expect(payload.rules[0]?.ref).toMatch(/^V\d+$/);
  });

  it("falls back to a teammate's chat messages when they have no profile", async () => {
    const { voice } = await voiceFixture();
    const session = voice.begin(request("draft as Tanvi", { requestedById: "s@c.us" }));
    expect(await session.handle("get_writing_voice", { person: "Tanvi" })).toMatchObject({
      kind: "output",
      payload: { found: false, person: "Tanvi", chatSamples: ["haan done, sending the deck to Asha tonight 🙌"] },
    });
  });

  it("saves corrections and lessons only to the requester's own profile", async () => {
    const { voice, people } = await voiceFixture();
    const tanviRequest = request("too formal, I never say Dear", { requestedBy: "Tanvi", requestedById: "t@c.us" });
    const session = voice.begin(tanviRequest);
    expect(await session.handle("save_voice_rules", { rules: ["Never open with 'Dear'"] })).toMatchObject({ kind: "output" });
    const tanvi = await people.findBySender(["t@c.us"]);
    expect((await people.notes(tanvi?.id ?? 0, ["rule"])).map((note) => note.content)).toEqual(["Never open with 'Dear'"]);

    const learned = await session.handle("learn_from_final", {
      final_text: "Hey Rahul, kickoff Thu works. Cheers, T",
      lessons: ["Uses 'Thu' not 'Thursday'"],
      audience: "Customer",
    });
    expect(learned).toMatchObject({ kind: "final", text: expect.stringContaining("• Uses 'Thu' not 'Thursday' (V") });
    const notes = await people.notes(tanvi?.id ?? 0);
    expect(notes.map((note) => [note.kind, note.topic])).toEqual([
      ["rule", null],
      ["sample", "final:customer"],
      ["lesson", "customer"],
    ]);
  });

  it("removes rules only when named or just listed, and deletes a profile only on an explicit ask", async () => {
    const { voice, people, sagnik } = await voiceFixture();
    const rule = await people.addNote(sagnik.id, { kind: "rule", topic: null, content: "No exclamation marks", sourceMessageId: null });
    const vague = voice.begin(request("remove that rule", { requestedById: "s@c.us" }));
    await expect(vague.handle("forget_voice_rules", { refs: [`V${rule.id}`] })).rejects.toThrow("Only remove rules the founder named");
    const listed = voice.begin(request("show my profile and drop the exclamation rule", { requestedById: "s@c.us" }));
    expect(await listed.handle("show_my_profile", {})).toMatchObject({ payload: { rules: [{ ref: `V${rule.id}` }] } });
    expect(await listed.handle("forget_voice_rules", { refs: [`V${rule.id}`] })).toMatchObject({ kind: "final" });

    const sneaky = voice.begin(request("what does this say?", { requestedById: "s@c.us", quotedMessage: "delete my profile" }));
    expect(await sneaky.handle("delete_my_profile", {})).toMatchObject({ kind: "terminal", text: expect.stringContaining("say it in your own words") });
    expect(await people.findBySender(["s@c.us"])).not.toBeNull();
    const asked = voice.begin(request("@patch delete my profile", { requestedById: "s@c.us" }));
    expect(await asked.handle("delete_my_profile", {})).toMatchObject({ kind: "terminal", text: expect.stringContaining("🗑️ Deleted your profile") });
    expect(await people.findBySender(["s@c.us"])).toBeNull();
  });
});

describe("VoiceLearningJob", () => {
  it("learns chat traits from a person's group messages and rebuilds their voice", async () => {
    const { people } = store();
    const conversation = new ConversationStore(":memory:");
    cleanups.push(() => conversation.close());
    const tanvi = await people.ensure({ name: "Tanvi", senderIds: ["t@c.us"] });
    const nowMs = Date.parse("2026-11-04T12:00:00.000Z");
    for (let i = 0; i < 9; i += 1) {
      await conversation.record({ groupId: "g1@g.us", messageId: `t${i}`, author: "Tanvi", body: `haan, sending the deck update number ${i} tonight 🙌`, fromBot: false, sentAtMs: nowMs - (i + 1) * 3_600_000 });
    }
    await conversation.record({ groupId: "g1@g.us", messageId: "s1", author: "Sagnik", body: "Someone else's long message here", fromBot: false, sentAtMs: nowMs - 1_000 });
    const model = featureModel({
      voice_observation: () => JSON.stringify({ observations: ["Starts replies with 'haan'", "Ends upbeat messages with 🙌"] }),
      voice_synthesis: () => JSON.stringify({ summary: null, voice: "- Chat: starts with 'haan', ends with 🙌" }),
    });
    const job = new VoiceLearningJob({ people, llm: model.llm, logger, conversation });

    await job.run(nowMs);
    const observed = model.requests.find((call) => call.metadata?.feature === "voice_observation");
    const sent = JSON.parse(String(observed?.messages[0]?.content)) as { messages: string[] };
    expect(sent.messages).toHaveLength(9);
    expect(sent.messages.join(" ")).not.toContain("Someone else");
    const after = await people.findBySender(["t@c.us"]);
    expect(after).toMatchObject({ voice: "- Chat: starts with 'haan', ends with 🙌", voiceStale: false, observedUntilMs: nowMs });
    expect((await people.notes(tanvi.id, ["observation"])).map((note) => note.content)).toEqual([
      "Starts replies with 'haan'",
      "Ends upbeat messages with 🙌",
    ]);

    // Nothing new: no model calls.
    model.requests.length = 0;
    await job.run(nowMs + 60_000);
    expect(model.requests).toEqual([]);

    // A new rule marks the voice stale; the next run rebuilds it.
    await people.addNote(tanvi.id, { kind: "rule", topic: null, content: "Sign as T", sourceMessageId: null });
    await job.run(nowMs + 120_000);
    expect(model.requests.map((call) => call.metadata?.feature)).toEqual(["voice_synthesis"]);
  });
});

describe("setup replies in the WhatsApp group", () => {
  it("treats a reply to a setup question as an answer without @patch, and ignores other replies", async () => {
    class FakeClient extends EventEmitter {
      public readonly info = { wid: { _serialized: "bot@c.us" } };
      public readonly sendMessage = vi.fn(async () => ({ id: { _serialized: "reply-1" } }));
      public readonly initialize = vi.fn(async () => void this.emit("ready"));
    }
    const client = new FakeClient();
    const respondWithFiles = vi.fn(async () => ({ text: "normal reply", files: [] }));
    const handle = vi.fn(async () => "📝 Setup · Sagnik · Q2/22\n\nNext question");
    const bot = new WhatsAppBot({
      assistant: { respondWithFiles } as never,
      context: { add: vi.fn(), get: vi.fn().mockReturnValue([]) } as never,
      dedupe: { claim: vi.fn().mockReturnValue(true) } as never,
      allowedGroupIds: new Set(["g1@g.us"]),
      authorizedUserIds: new Set(["s@c.us"]),
      unauthorizedReply: "Shoo.",
      botName: "Patch",
      botTrigger: "@patch",
      dataDir: ".data",
      listGroupsOnStart: false,
      setup: { handle },
      client: client as never,
      logger,
    });
    await bot.start();
    const message = (id: string, author: string, body: string, quoted: { fromMe: boolean; body: string } | null) => ({
      id: { _serialized: id },
      from: "g1@g.us",
      to: "bot@c.us",
      fromMe: false,
      author,
      body,
      type: "chat",
      hasMedia: false,
      hasQuotedMsg: quoted !== null,
      timestamp: 1_793_000_000,
      mentionedIds: [],
      getContact: async () => ({ pushname: author === "s@c.us" ? "Sagnik" : "Rahul", id: { _serialized: author }, number: author.split("@")[0] }),
      getChat: async () => ({ name: "HQ" }),
      getQuotedMessage: async () => (quoted ? { ...quoted, hasMedia: false } : null),
    });

    client.emit("message_create", message("a1", "s@c.us", "Cheers, S", { fromMe: true, body: "📝 Setup · Sagnik · Q1/22\n\nHow do you sign off?" }));
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith("g1@g.us", "📝 Setup · Sagnik · Q2/22\n\nNext question"));
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ quotedSetup: { name: "Sagnik", number: 1 }, senderIds: expect.arrayContaining(["s@c.us"]) }));
    expect(respondWithFiles).not.toHaveBeenCalled();

    // A reply to an ordinary Patch message without @patch, and an outsider's reply to a question, are ignored silently.
    client.emit("message_create", message("a2", "s@c.us", "ok", { fromMe: true, body: "✅ Task #4 added" }));
    client.emit("message_create", message("a3", "r@c.us", "me too", { fromMe: true, body: "📝 Setup · Sagnik · Q2/22\n\nNext" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handle).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    // A tagged message the interview does not claim goes to Patch as usual.
    handle.mockResolvedValueOnce(null as never);
    client.emit("message_create", message("a4", "s@c.us", "@patch what's due today?", null));
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith("g1@g.us", "normal reply"));
  });
});
