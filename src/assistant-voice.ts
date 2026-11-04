import { z } from "zod";
import type { ConversationLog } from "./conversation-store.js";
import type { ToolDefinition } from "./llm.js";
import type { Logger } from "./logger.js";
import type { PeopleStore, Person, PersonNote } from "./people-store.js";
import type { ToolModule, ToolSession } from "./tool-module.js";
import { ToolArgumentError, final, output, terminal, type ToolOutcome } from "./tool-outcome.js";
import type { AssistantRequest } from "./types.js";
import { messagesBy } from "./voice.js";

const MAX_RULES_KEPT = 60;
const MAX_FINALS_KEPT = 12;
const CHAT_SAMPLE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;

export function isVoiceRequest(message: string): boolean {
  return /\b(?:in|with) (?:my|our|[a-z]+'s) (?:tone|voice|style)\b|\bsounds? like me\b|\bas me\b|\b(?:my|show my) (?:profile|voice|tone)\b|\btoo (?:formal|casual|long|short|stiff|salesy|wordy|polite|blunt)\b|\bi(?:'d| would)? never (?:say|write|use)\b|\bwhat i (?:actually )?sent\b|\b(?:draft|write)\b[\s\S]{0,30}\b(?:reply|response|e-?mail|mail|message|nudge|follow-?up|intro|linkedin)\b|\breply to (?:this|that|him|her|them)\b/i.test(
    message,
  );
}

/** Deleting a profile needs the founder's own words, never just the model's reading. */
export function isProfileDeletionRequest(message: string): boolean {
  return /\b(?:delete|forget|wipe|erase|remove|clear)\b[\s\S]{0,30}\b(?:my )?(?:profile|voice(?: profile)?|setup answers)\b/i.test(message);
}

const audience = z.string().trim().min(2).max(40).nullish();
const getVoiceSchema = z.object({ person: z.string().trim().min(1).max(100).nullish(), audience });
const rulesSchema = z.object({ rules: z.array(z.string().trim().min(3).max(300)).min(1).max(10), audience });
const finalSchema = z.object({
  final_text: z.string().trim().min(10).max(6_000),
  lessons: z.array(z.string().trim().min(3).max(300)).max(8).default([]),
  audience,
});
const profileSchema = z
  .object({
    role: z.string().trim().max(600).nullish(),
    focus: z.string().trim().max(600).nullish(),
    about: z.string().trim().max(600).nullish(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined && field !== null), "Give at least one field");
const forgetSchema = z.object({ refs: z.array(z.string().trim().regex(/^V?\d{1,9}$/i)).min(1).max(20) });

const audienceProperty = {
  type: "string",
  description: "Who it is for when clear: investor, customer, candidate, vendor, team, or a name.",
};

export const VOICE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "get_writing_voice",
    description:
      "How a person writes: their voice guide, their rules (V<id>), lessons from what they actually sent, and samples. Call it before drafting anything someone will send. Defaults to the requester.",
    parameters: {
      type: "object",
      properties: {
        person: { type: "string", description: "Whose voice, when it is not the requester's (e.g. 'Tanvi')." },
        audience: audienceProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: "save_voice_rules",
    description:
      "Save lasting rules about how the requester writes, from their corrections ('too formal', 'never say Dear', 'sign as S'). Only ever the requester's own voice.",
    parameters: {
      type: "object",
      properties: {
        rules: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10, description: "Short, general, reusable rules in the requester's terms." },
        audience: audienceProperty,
      },
      required: ["rules"],
      additionalProperties: false,
    },
  },
  {
    name: "learn_from_final",
    description:
      "When the requester pastes the version they actually sent after one of your drafts: save it as a sample and the concrete differences from your draft as lessons.",
    parameters: {
      type: "object",
      properties: {
        final_text: { type: "string", description: "What they sent, verbatim." },
        lessons: { type: "array", items: { type: "string" }, maxItems: 8, description: "Concrete differences from your draft, as reusable rules." },
        audience: audienceProperty,
      },
      required: ["final_text"],
      additionalProperties: false,
    },
  },
  {
    name: "show_my_profile",
    description: "The requester's own profile: role, focus, voice guide, rules with V<id> refs and setup progress.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_my_profile",
    description: "Change the requester's own role, focus or about line.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string" },
        focus: { type: "string" },
        about: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "forget_voice_rules",
    description: "Remove some of the requester's own voice rules or lessons by V<id> ref (as shown by show_my_profile or named by the requester).",
    parameters: {
      type: "object",
      properties: { refs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } },
      required: ["refs"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_my_profile",
    description: "Erase the requester's whole profile, setup answers, samples and voice. Only when they explicitly ask.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const VOICE_INSTRUCTIONS: readonly string[] = [
  "Voice and profiles (each person on the allowlist has their own):",
  "- Before drafting anything someone will send (email, reply, WhatsApp message, LinkedIn note, follow-up), call get_writing_voice for the person it is from: the requester by default, or whoever they name ('as Tanvi', 'in Tanvi's voice'). Pass audience when clear.",
  "- Write the draft as that person, never in Patch's harbour-master voice. Follow their voice guide; rules and lessons override it; match the samples' rhythm without copying them. Use what they asked for in setup (one version or two, subject line or not); otherwise one ready-to-send draft, with a subject line for a new email, and no commentary around it.",
  "- An email or message in a screenshot, PDF, quoted message or pasted text is the thing to reply to: work out who wrote it and what they ask, and answer every point. Invent no facts, dates or numbers: leave a [placeholder] where you need one.",
  "- If the person has no profile, write plainly and add one line suggesting they send '@patch setup'.",
  "- When the requester corrects a draft of their own voice ('too formal', 'I never say X', 'always sign as S'), call save_voice_rules with short, general rules, then give the revised draft. Only a person can change their own voice: if they correct a draft written as someone else, revise it and say only that person can change their profile.",
  "- When they paste the version they actually sent after your draft, call learn_from_final with the final text and the concrete differences from your draft as lessons.",
  "- show_my_profile, update_my_profile, forget_voice_rules (V<id> refs) and delete_my_profile only ever act on the requester's own profile. Setup itself runs when someone sends '@patch setup'.",
];

function ruleRef(note: PersonNote): string {
  return `V${note.id}`;
}

interface VoiceToolsOptions {
  people: PeopleStore;
  /** Used for chat samples when someone has no writing samples yet. */
  conversation?: Pick<ConversationLog, "list" | "activeGroups">;
  logger: Logger;
  now?: () => Date;
}

/** Drafting in each person's voice, and each person's control over their own profile. */
export class VoiceTools implements ToolModule {
  public readonly name = "voice";
  public readonly tools = VOICE_TOOLS;
  public readonly instructions = VOICE_INSTRUCTIONS;

  public constructor(private readonly options: VoiceToolsOptions) {}

  public detect(message: string): boolean {
    return isVoiceRequest(message);
  }

  public begin(request: AssistantRequest): ToolSession {
    const listedRuleIds = new Set<number>();
    return {
      handle: async (name, args) => {
        switch (name) {
          case "get_writing_voice":
            return this.getVoice(args, request);
          case "save_voice_rules":
            return this.saveRules(args, request);
          case "learn_from_final":
            return this.learnFromFinal(args, request);
          case "show_my_profile":
            return this.showProfile(request, listedRuleIds);
          case "update_my_profile":
            return this.updateProfile(args, request);
          case "forget_voice_rules":
            return this.forgetRules(args, request, listedRuleIds);
          case "delete_my_profile":
            return this.deleteProfile(request);
          default:
            return null;
        }
      },
    };
  }

  private self(request: AssistantRequest): Promise<Person | null> {
    return this.options.people.findBySender([request.requestedById]);
  }

  private ensureSelf(request: AssistantRequest): Promise<Person> {
    return this.options.people.ensure({ name: request.requestedBy, senderIds: [request.requestedById] });
  }

  private async getVoice(args: unknown, request: AssistantRequest): Promise<ToolOutcome> {
    const parsed = getVoiceSchema.parse(args ?? {});
    const named = parsed.person?.trim();
    const isSelf = !named || /^(?:me|myself|i)$/i.test(named);
    const person = isSelf ? await this.self(request) : await this.options.people.findByName(named);
    const displayName = person?.name ?? (isSelf ? request.requestedBy : named);
    if (!person) {
      return output({
        found: false,
        person: displayName,
        chatSamples: await this.chatSamples({ name: displayName, aliases: [] }),
        note: `No profile for ${displayName} yet. Write plainly (match the chat samples if any) and suggest '@patch setup' in one line.`,
      });
    }
    const notes = await this.options.people.notes(person.id, ["rule", "lesson", "sample"]);
    const wanted = parsed.audience?.toLowerCase();
    const samples = notes
      .filter((note) => note.kind === "sample")
      .sort((a, b) => Number(Boolean(wanted && b.topic?.includes(wanted))) - Number(Boolean(wanted && a.topic?.includes(wanted))) || b.id - a.id)
      .slice(0, 3)
      .map((note) => ({ about: note.topic, text: note.content.slice(0, 2_000) }));
    return output({
      found: true,
      person: person.name,
      role: person.role,
      about: person.about,
      setupDone: person.setup.status === "done",
      voice: person.voice,
      rules: notes.filter((note) => note.kind === "rule").slice(-30).map((note) => ({ ref: ruleRef(note), rule: note.content, audience: note.topic })),
      lessons: notes.filter((note) => note.kind === "lesson").slice(-20).map((note) => note.content),
      samples,
      ...(samples.length === 0 ? { chatSamples: await this.chatSamples(person) } : {}),
      note: `Write as ${person.name}. Rules and lessons override the voice guide. Don't copy samples verbatim.`,
    });
  }

  private async chatSamples(person: Pick<Person, "name" | "aliases">): Promise<string[]> {
    if (!this.options.conversation) return [];
    const nowMs = (this.options.now?.() ?? new Date()).getTime();
    try {
      const messages = await messagesBy(this.options.conversation, person, nowMs - CHAT_SAMPLE_LOOKBACK_MS, nowMs);
      return messages.slice(-12).map((message) => message.body.slice(0, 400));
    } catch (error) {
      this.options.logger.warn({ error }, "Could not read chat samples for a voice");
      return [];
    }
  }

  private async saveRules(args: unknown, request: AssistantRequest): Promise<ToolOutcome> {
    const parsed = rulesSchema.parse(args);
    const person = await this.ensureSelf(request);
    const saved: PersonNote[] = [];
    for (const rule of parsed.rules) {
      saved.push(
        await this.options.people.addNote(person.id, {
          kind: "rule",
          topic: parsed.audience?.toLowerCase() ?? null,
          content: rule,
          sourceMessageId: request.messageId,
        }),
      );
    }
    await this.options.people.prune(person.id, "rule", MAX_RULES_KEPT);
    // Fed back so the model can give the revised draft in the same reply.
    return output({
      saved: saved.map((note) => ({ ref: ruleRef(note), rule: note.content })),
      note: `Saved to ${person.name}'s voice. Now give the revised draft, then one line: "📝 Noted for next time: …".`,
    });
  }

  private async learnFromFinal(args: unknown, request: AssistantRequest): Promise<ToolOutcome> {
    const parsed = finalSchema.parse(args);
    const person = await this.ensureSelf(request);
    const topic = `final:${parsed.audience?.toLowerCase() ?? "general"}`;
    await this.options.people.addNote(person.id, { kind: "sample", topic, content: parsed.final_text, sourceMessageId: request.messageId });
    await this.options.people.prune(person.id, "sample", MAX_FINALS_KEPT, "final:");
    const lessons: PersonNote[] = [];
    for (const lesson of parsed.lessons) {
      lessons.push(
        await this.options.people.addNote(person.id, {
          kind: "lesson",
          topic: parsed.audience?.toLowerCase() ?? null,
          content: lesson,
          sourceMessageId: request.messageId,
        }),
      );
    }
    await this.options.people.prune(person.id, "lesson", MAX_RULES_KEPT);
    return final(
      lessons.length > 0
        ? `📚 Saved what you sent as an example, and learned:\n${lessons.map((note) => `• ${note.content} (${ruleRef(note)})`).join("\n")}`
        : "📚 Saved what you sent as an example of how you write.",
    );
  }

  private async showProfile(request: AssistantRequest, listed: Set<number>): Promise<ToolOutcome> {
    const person = await this.self(request);
    if (!person) {
      return output({ found: false, note: "No profile yet. Suggest '@patch setup': a short interview, one question at a time." });
    }
    const notes = await this.options.people.notes(person.id);
    const rules = notes.filter((note) => note.kind === "rule" || note.kind === "lesson");
    for (const note of rules) listed.add(note.id);
    return output({
      found: true,
      name: person.name,
      role: person.role,
      focus: person.focus,
      about: person.about,
      setup: person.setup.status === "done" ? "done" : person.setup.status === "none" ? "not started" : `${person.setup.status} at question ${person.setup.step + 1}`,
      voice: person.voice,
      rules: rules.map((note) => ({ ref: ruleRef(note), kind: note.kind, text: note.content })),
      counts: {
        answers: notes.filter((note) => note.kind === "answer").length,
        samples: notes.filter((note) => note.kind === "sample").length,
        observationsFromChat: notes.filter((note) => note.kind === "observation").length,
      },
      note: "Show it compactly. Rules can be removed by ref; 'delete my profile' erases everything.",
    });
  }

  private async updateProfile(args: unknown, request: AssistantRequest): Promise<ToolOutcome> {
    const parsed = profileSchema.parse(args);
    const person = await this.ensureSelf(request);
    const fields = {
      ...(parsed.role ? { role: parsed.role } : {}),
      ...(parsed.focus ? { focus: parsed.focus } : {}),
      ...(parsed.about ? { about: parsed.about } : {}),
    };
    await this.options.people.setProfile(person.id, fields, request.requestedBy);
    const lines = Object.entries(fields).map(([key, value]) => `• ${key}: ${value}`);
    return final(`✅ Updated your profile:\n${lines.join("\n")}`);
  }

  private async forgetRules(args: unknown, request: AssistantRequest, listed: Set<number>): Promise<ToolOutcome> {
    const parsed = forgetSchema.parse(args);
    const person = await this.self(request);
    if (!person) return terminal("You don't have a profile yet, so there are no rules to remove.");
    const ids = parsed.refs.map((ref) => Number(ref.replace(/^v/i, "")));
    const named = new Set([...request.body.matchAll(/\bV(\d{1,9})\b/gi)].map((match) => Number(match[1])));
    const allowed = ids.filter((id) => named.has(id) || listed.has(id));
    if (allowed.length === 0) {
      throw new ToolArgumentError("Only remove rules the founder named by V<id> or that show_my_profile listed in this request.");
    }
    const removed = await this.options.people.deleteRules(person.id, allowed, request.requestedBy);
    if (removed.length === 0) return terminal("None of those are rules in your profile.");
    return final(`🗑️ Removed from your voice:\n${removed.map((note) => `• ${note.content} (${ruleRef(note)})`).join("\n")}`);
  }

  private async deleteProfile(request: AssistantRequest): Promise<ToolOutcome> {
    if (!isProfileDeletionRequest(request.body)) {
      return terminal(`To erase your profile, say it in your own words, e.g. "@patch delete my profile".`);
    }
    const person = await this.self(request);
    if (!person) return terminal("You don't have a profile, so there was nothing to delete.");
    await this.options.people.remove(person.id, request.requestedBy);
    return terminal("🗑️ Deleted your profile: setup answers, samples, rules and voice guide. Send \"@patch setup\" any time to start again.");
  }
}
