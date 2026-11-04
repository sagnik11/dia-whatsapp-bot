import { z } from "zod";
import type { ChecklistItem, ChecklistStore } from "./checklist-store.js";
import {
  FOLLOW_UP_STATUSES,
  FollowUpValidationError,
  type FollowUpRecord,
  type FollowUpStore,
} from "./follow-up-store.js";
import type { ToolDefinition } from "./llm.js";
import type { Logger } from "./logger.js";
import { MEMORY_KINDS, type MemoryRecord, type MemoryStore, type MemoryViewer } from "./memory-store.js";
import type { PeopleStore } from "./people-store.js";
import {
  RECURRENCE_FREQUENCIES,
  RecurringValidationError,
  describeRule,
  type RecurringTaskRecord,
  type RecurringTaskStore,
} from "./recurring-store.js";
import { TASK_AREAS, TASK_PRIORITIES, type TaskStore } from "./task-store.js";
import { formatDueForDisplay, resolveDueTimestamp } from "./time.js";
import type { ToolModule, ToolSession } from "./tool-module.js";
import { ToolArgumentError, final, output, type ToolOutcome } from "./tool-outcome.js";
import type { AssistantRequest } from "./types.js";

export interface Phase1Services {
  memory: MemoryStore;
  followUps: FollowUpStore;
  recurring: RecurringTaskStore;
  checklists: ChecklistStore;
  /** Gives each person a private memory beside the group's shared one. Without it, all memory is shared. */
  people?: Pick<PeopleStore, "ensure">;
}

export interface Phase1State {
  request: AssistantRequest;
  knownTaskIds: Set<number>;
  knownMemoryIds: Set<number>;
  knownFollowUpIds: Set<number>;
  knownRecurringIds: Set<number>;
  /** The requester's people.id, resolved once per request for private memory. */
  personId?: number;
}

// --- Detection and id references ------------------------------------------------

export function isMemoryRequest(message: string): boolean {
  return /\b(?:remember|memory|memories|forget|recall|what do (?:we|you) know about|log (?:a |the |this )?decision|decision log|what (?:did|have) we decided?)\b/i.test(
    message,
  );
}

export function isFollowUpRequest(message: string): boolean {
  return /\bfollow[\s-]?ups?\b|\b(?:i|we|she|he|they|tanvi|sagnik)\s+(?:told|promised|owe)\b|\bwaiting on\b|\bowes? us\b/i.test(
    message,
  );
}

export function isRecurringRequest(message: string): boolean {
  return (
    /\brecurring\b|\brepeat(?:ing)?\s+task\b/i.test(message) ||
    (/\b(?:every|each)\s+(?:day|weekday|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?:st|nd|rd|th)?)\b/i.test(
      message,
    ) &&
      !/\bremind\s+me\b/i.test(message))
  );
}

export function isChecklistRequest(message: string): boolean {
  return /\bchecklist\b|\btick\b|\bcheck\s+off\b|\buntick\b/i.test(message);
}

export function isUndoRequest(message: string): boolean {
  return /\bundo\b|\brevert\s+(?:that|the last|my last)\b/i.test(message);
}

export function isPhase1Request(message: string): boolean {
  return (
    isMemoryRequest(message) ||
    isFollowUpRequest(message) ||
    isRecurringRequest(message) ||
    isChecklistRequest(message) ||
    isUndoRequest(message)
  );
}

function collectIds(text: string, patterns: readonly RegExp[]): Set<number> {
  const ids = new Set<number>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const id of (match[1] ?? "").matchAll(/\d{1,9}/g)) ids.add(Number(id[0]));
    }
  }
  return ids;
}

/** Ids a founder referenced as M12 / F3 / R2, or "memory 12", "follow-up 3", "recurring 2". */
export function referencedPhase1Ids(text: string) {
  return {
    memories: collectIds(text, [/\bM(\d{1,9})\b/g, /\bmemor(?:y|ies)\s*#?((?:\d{1,9}(?:\s*(?:,|&|\band\b)\s*)?)+)/gi]),
    followUps: collectIds(text, [/\bF(\d{1,9})\b/g, /\bfollow[\s-]?ups?\s*#?((?:\d{1,9}(?:\s*(?:,|&|\band\b)\s*)?)+)/gi]),
    recurring: collectIds(text, [/\bR(\d{1,9})\b/g, /\brecurring(?:\s+task)?\s*#?((?:\d{1,9}(?:\s*(?:,|&|\band\b)\s*)?)+)/gi]),
  };
}

// --- Schemas ------------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || null);

const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : value);

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const weekdaySchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const index = WEEKDAYS.findIndex((day) => day.startsWith(value.trim().toLowerCase().slice(0, 3)));
  return index >= 0 ? index + 1 : Number(value);
}, z.number().int().min(1).max(7).nullish());

const rememberSchema = z.object({
  scope: z.preprocess(lower, z.enum(["personal", "shared"]).nullish()),
  kind: z.preprocess(lower, z.enum(MEMORY_KINDS)),
  subject: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(1_000),
});

const searchMemorySchema = z.object({
  text: optionalText(200),
  kind: z.preprocess(lower, z.enum(MEMORY_KINDS).nullish()),
  days_back: z.coerce.number().int().min(1).max(3_650).nullish(),
  limit: z.coerce.number().int().min(1).max(50).nullish(),
});

const forgetMemorySchema = z.object({ memory_id: z.coerce.number().int().positive() });

const createFollowUpsSchema = z.object({
  follow_ups: z
    .array(
      z.object({
        owner: optionalText(100),
        counterparty: z.string().trim().min(1).max(100),
        promise: z.string().trim().min(1).max(300),
        due_at: optionalText(100),
        notes: optionalText(2_000),
      }),
    )
    .min(1)
    .max(20),
});

const listFollowUpsSchema = z.object({
  status: z.preprocess(lower, z.enum([...FOLLOW_UP_STATUSES, "all"]).nullish()),
  owner: optionalText(100),
  counterparty: optionalText(100),
  due_to: optionalText(100),
  limit: z.coerce.number().int().min(1).max(50).nullish(),
});

const updateFollowUpsSchema = z.object({
  updates: z
    .array(
      z.object({
        follow_up_id: z.coerce.number().int().positive(),
        status: z.preprocess(lower, z.enum(FOLLOW_UP_STATUSES).nullish()),
        due_at: optionalText(100),
        notes: optionalText(2_000),
        promise: optionalText(300),
      }),
    )
    .min(1)
    .max(20),
});

const createRecurringSchema = z.object({
  title: z.string().trim().min(1).max(200),
  frequency: z.preprocess(lower, z.enum(RECURRENCE_FREQUENCIES)),
  every: z.coerce.number().int().min(1).max(12).nullish(),
  weekday: weekdaySchema,
  day_of_month: z.coerce.number().int().min(1).max(31).nullish(),
  starts_on: optionalText(10),
  owner: optionalText(100),
  area: optionalText(50),
  priority: z.preprocess(lower, z.enum(TASK_PRIORITIES).nullish()),
  notes: optionalText(2_000),
});

const updateRecurringSchema = z.object({
  recurring_id: z.coerce.number().int().positive(),
  action: z.preprocess(lower, z.enum(["pause", "resume", "delete"])),
});

const addChecklistSchema = z.object({
  task_id: z.coerce.number().int().positive(),
  items: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
});

const tickChecklistSchema = z.object({
  task_id: z.coerce.number().int().positive(),
  item_numbers: z.array(z.coerce.number().int().positive()).min(1).max(30),
  done: z.boolean().nullish(),
});

// --- Tool definitions -----------------------------------------------------------

const memoryKindsList = [...MEMORY_KINDS];

export const PHASE1_TOOLS: readonly ToolDefinition[] = [
  {
    name: "search_memory",
    description:
      "Search long-term memory: this group's shared memory plus the requester's own private memory. Decisions, commitments, facts, people and preferences distilled from past conversations (they outlive the 90-day log). Use for 'what do we know about X', past decisions, and anything older than the last few days. Private items come back with personal: true.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Words that must appear, e.g. a company or topic." },
        kind: { type: "string", enum: memoryKindsList },
        days_back: { type: "integer", minimum: 1, maximum: 3650 },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "remember",
    description:
      "Save one item to long-term memory when someone says 'remember…', 'log decision…', or states something they want kept. Decisions go in as kind decision (the decision log).",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["personal", "shared"],
          description:
            "personal: only the requester will ever see it (their notes, preferences, own commitments). shared: everyone in the group (team decisions, company facts, anything said to be for everyone). Default: shared for decisions, personal otherwise.",
        },
        kind: { type: "string", enum: memoryKindsList },
        subject: { type: "string", description: "Short topic or entity, e.g. 'pricing', 'Acme pilot'." },
        content: { type: "string", description: "One self-contained sentence with names and absolute dates." },
      },
      required: ["kind", "subject", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "forget_memory",
    description: "Remove one memory (M<id>) when a founder asks. Use an id from search_memory in this request or one the founder named.",
    parameters: {
      type: "object",
      properties: { memory_id: { type: "integer", minimum: 1 } },
      required: ["memory_id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_follow_ups",
    description:
      "Track promises made to or expected from people outside the group ('I told Rahul I'd send the proposal by Friday', 'waiting on the CA for the PAN copy').",
    parameters: {
      type: "object",
      properties: {
        follow_ups: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              owner: { type: "string", description: "Founder responsible; 'me' means the sender." },
              counterparty: { type: "string", description: "The outside person or company." },
              promise: { type: "string", description: "What was promised, verb first." },
              due_at: { type: "string", description: "ISO 8601 date or datetime." },
              notes: { type: "string" },
            },
            required: ["counterparty", "promise"],
            additionalProperties: false,
          },
        },
      },
      required: ["follow_ups"],
      additionalProperties: false,
    },
  },
  {
    name: "list_follow_ups",
    description: "List follow-ups (F<id>), open ones soonest due first by default.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...FOLLOW_UP_STATUSES, "all"] },
        owner: { type: "string" },
        counterparty: { type: "string" },
        due_to: { type: "string", description: "Inclusive ISO 8601 end date." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_follow_ups",
    description:
      "Close (done/dropped), reopen, re-date, or add notes to follow-ups by F<id>. Use ids the founder named or that list_follow_ups returned in this request.",
    parameters: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              follow_up_id: { type: "integer", minimum: 1 },
              status: { type: "string", enum: [...FOLLOW_UP_STATUSES] },
              due_at: { type: "string" },
              notes: { type: "string", description: "Appended to existing notes." },
              promise: { type: "string" },
            },
            required: ["follow_up_id"],
            additionalProperties: false,
          },
        },
      },
      required: ["updates"],
      additionalProperties: false,
    },
  },
  {
    name: "create_recurring_task",
    description:
      "Set up a task that is added to the list automatically on a schedule ('every Monday: send the pipeline update', 'on the 5th of every month: pay contractors'). Each run adds a normal task due that day; nothing is posted to the group.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        frequency: { type: "string", enum: [...RECURRENCE_FREQUENCIES] },
        every: { type: "integer", minimum: 1, maximum: 12, description: "Interval, default 1." },
        weekday: { type: "integer", minimum: 1, maximum: 7, description: "Weekly: 1 = Monday … 7 = Sunday." },
        day_of_month: { type: "integer", minimum: 1, maximum: 31, description: "Monthly: day of the month." },
        starts_on: { type: "string", description: "First eligible date, YYYY-MM-DD. Default today." },
        owner: { type: "string" },
        area: { type: "string", enum: [...TASK_AREAS] },
        priority: { type: "string", enum: [...TASK_PRIORITIES] },
        notes: { type: "string" },
      },
      required: ["title", "frequency"],
      additionalProperties: false,
    },
  },
  {
    name: "list_recurring_tasks",
    description: "List recurring task templates (R<id>) with their schedule and next run.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_recurring_task",
    description: "Pause, resume, or delete one recurring task template by R<id>.",
    parameters: {
      type: "object",
      properties: {
        recurring_id: { type: "integer", minimum: 1 },
        action: { type: "string", enum: ["pause", "resume", "delete"] },
      },
      required: ["recurring_id", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "add_checklist_items",
    description: "Add numbered checklist items to one task by #id.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", minimum: 1 },
        items: { type: "array", minItems: 1, maxItems: 30, items: { type: "string" } },
      },
      required: ["task_id", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "tick_checklist_items",
    description: "Tick (or untick with done=false) checklist items on one task by their numbers.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", minimum: 1 },
        item_numbers: { type: "array", minItems: 1, maxItems: 30, items: { type: "integer", minimum: 1 } },
        done: { type: "boolean", description: "Default true." },
      },
      required: ["task_id", "item_numbers"],
      additionalProperties: false,
    },
  },
  {
    name: "undo_last_change",
    description:
      "Reverse the sender's most recent task change from the last 24 hours (a create, edit, or delete). Saying undo again steps further back.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const PHASE1_INSTRUCTIONS: readonly string[] = [
  "Long-term memory:",
  "- Every night Patch distills decisions, commitments, facts, people and preferences from the conversation into memory that outlives the 90-day log.",
  "- Use search_memory for 'what do we know about X', past decisions, and anything that may be older than the last few days; use read_group_conversation for recent detail. Cite memories with who said it and when.",
  "- Use remember when someone says 'remember…' or 'log decision…'; decisions are the decision log. Use forget_memory only when asked.",
  "- Everyone has a private memory beside the group's shared one. remember saves to the requester's private memory (scope personal) for their own notes, preferences and commitments; use scope shared for team decisions, company facts stated as 'we…', and anything they say is for everyone or the team. A private memory belongs to its owner only: never quote one in a reply to someone else.",
  "Shared lists, personal views: tasks and follow-ups are one shared list. First-person asks ('my tasks', 'what's on my plate', 'what do I owe people') filter by the requester as owner; 'we', 'the team' or 'everyone' means all of them.",
  "Follow-ups (F<id>): promises to or from people outside the group. Use create_follow_ups, list_follow_ups and update_follow_ups.",
  "Recurring tasks (R<id>): use create_recurring_task for anything on a schedule; each run silently adds a normal task due that day.",
  "Checklists: add_checklist_items and tick_checklist_items work on one exact task #id.",
  "Undo: undo_last_change reverses the sender's most recent task change in the last 24 hours.",
  "Minutes and agendas: for minutes, use the voice-note transcript or read_group_conversation and give decisions, owners, actions and open questions; save them only when asked (remember, create_tasks, create_follow_ups). For an agenda, combine list_tasks (overdue, blocked, due soon), list_follow_ups, recent decisions from search_memory, and the recent conversation.",
];

// --- Formatting ---------------------------------------------------------------------

function followUpLine(followUp: FollowUpRecord, timezone: string): string {
  const due = followUp.dueAt ? ` — due ${formatDueForDisplay(followUp.dueAt, timezone)}` : "";
  return `F${followUp.id} ${followUp.owner} → ${followUp.counterparty}: ${followUp.promise}${due}`;
}

function checklistLines(items: readonly ChecklistItem[]): string {
  return items.map((item) => `${item.done ? "☑" : "☐"} ${item.number}. ${item.text}`).join("\n");
}

function memoryForModel(memory: MemoryRecord) {
  return {
    id: memory.id,
    ref: `M${memory.id}`,
    kind: memory.kind,
    subject: memory.subject,
    content: memory.content,
    saidBy: memory.sourceAuthor,
    when: memory.observedAt,
    ...(memory.ownerId ? { personal: true } : {}),
  };
}

// --- Handlers -----------------------------------------------------------------------

export class Phase1Tools implements ToolModule {
  public readonly name = "phase1";
  public readonly tools = PHASE1_TOOLS;
  public readonly instructions = PHASE1_INSTRUCTIONS;

  public detect(message: string): boolean {
    return isPhase1Request(message);
  }

  public begin(request: AssistantRequest, knownTaskIds: Set<number>): ToolSession {
    const state = Phase1Tools.newState(request, knownTaskIds);
    return { handle: (name, args) => this.handle(name, args, state) };
  }

  public constructor(
    private readonly services: Phase1Services,
    private readonly tasks: TaskStore,
    private readonly timezone: string,
    private readonly logger: Logger,
  ) {}

  public static newState(request: AssistantRequest, knownTaskIds: Set<number>): Phase1State {
    const referenced = referencedPhase1Ids([request.body, request.quotedMessage ?? ""].join("\n"));
    return {
      request,
      knownTaskIds,
      knownMemoryIds: referenced.memories,
      knownFollowUpIds: referenced.followUps,
      knownRecurringIds: referenced.recurring,
    };
  }

  /** Returns null when the tool is not a Phase 1 tool. */
  public async handle(name: string, args: unknown, state: Phase1State): Promise<ToolOutcome | null> {
    switch (name) {
      case "search_memory":
        return this.searchMemory(args, state);
      case "remember":
        return this.remember(args, state);
      case "forget_memory":
        return this.forget(args, state);
      case "create_follow_ups":
        return this.createFollowUps(args, state);
      case "list_follow_ups":
        return this.listFollowUps(args, state);
      case "update_follow_ups":
        return this.updateFollowUps(args, state);
      case "create_recurring_task":
        return this.createRecurring(args, state);
      case "list_recurring_tasks":
        return this.listRecurring(state);
      case "update_recurring_task":
        return this.updateRecurring(args, state);
      case "add_checklist_items":
        return this.addChecklist(args, state);
      case "tick_checklist_items":
        return this.tickChecklist(args, state);
      case "undo_last_change":
        return this.undo(state);
      default:
        return null;
    }
  }

  private owner(value: string | null, state: Phase1State): string | null {
    if (!value) return null;
    return /^(?:me|myself|i)$/i.test(value) ? state.request.requestedBy : value;
  }

  private validateDue(value: string | null, field: string): void {
    if (value && resolveDueTimestamp(value, this.timezone) === null) {
      throw new ToolArgumentError(`${field} "${value}" is not an ISO 8601 date or datetime`);
    }
  }

  private unknown(ids: readonly number[], known: Set<number>, prefix: string, lister: string): ToolOutcome | null {
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length === 0) return null;
    return output({
      error: `Nothing was changed. ${missing.map((id) => `${prefix}${id}`).join(", ")} was neither named by the founder nor returned by ${lister} in this request. Call ${lister} first.`,
    });
  }

  /** The requester's view of memory: the group's shared memory plus their own private memory. */
  private async viewer(state: Phase1State): Promise<MemoryViewer> {
    if (!this.services.people) return { scope: "shared" };
    state.personId ??= (
      await this.services.people.ensure({ name: state.request.requestedBy, senderIds: [state.request.requestedById] })
    ).id;
    return { scope: "person", personId: state.personId };
  }

  private async searchMemory(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const parsed = searchMemorySchema.parse(args);
    const viewer = await this.viewer(state);
    const memories = await this.services.memory.search(state.request.groupId, {
      viewer,
      text: parsed.text,
      kind: parsed.kind ?? null,
      sinceIso: parsed.days_back
        ? new Date(Date.now() - parsed.days_back * 86_400_000).toISOString()
        : null,
      limit: parsed.limit ?? 20,
    });
    for (const memory of memories) state.knownMemoryIds.add(memory.id);
    return output({ count: memories.length, memories: memories.map(memoryForModel) });
  }

  private async remember(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const parsed = rememberSchema.parse(args);
    const scope = parsed.scope ?? (parsed.kind === "decision" ? "shared" : "personal");
    const viewer = scope === "personal" ? await this.viewer(state) : null;
    const ownerId = viewer?.scope === "person" ? viewer.personId : 0;
    const result = await this.services.memory.add(
      state.request.groupId,
      [
        {
          kind: parsed.kind,
          subject: parsed.subject,
          content: parsed.content,
          sourceAuthor: state.request.requestedBy,
          sourceMessageId: state.request.messageId,
          observedAt: new Date().toISOString(),
          ownerId,
        },
      ],
      state.request.requestedBy,
    );
    const memory = result.added[0];
    if (!memory) return final(`🧠 Already remembered: ${parsed.subject}.`);
    state.knownMemoryIds.add(memory.id);
    const label = memory.kind === "decision" ? "Decision logged" : "Remembered";
    const audience = !this.services.people ? "" : memory.ownerId ? " for you only" : " for everyone";
    return final(`🧠 ${label}${audience} (M${memory.id}, ${memory.kind}): ${memory.content}`);
  }

  private async forget(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const { memory_id: id } = forgetMemorySchema.parse(args);
    const blocked = this.unknown([id], state.knownMemoryIds, "M", "search_memory");
    if (blocked) return blocked;
    const memory = await this.services.memory.forget(state.request.groupId, id, state.request.requestedBy, await this.viewer(state));
    return final(memory ? `🗑️ Forgot M${id}: ${memory.content}` : `⚠️ M${id} is not in this group's memory or yours.`);
  }

  private async createFollowUps(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const parsed = createFollowUpsSchema.parse(args);
    parsed.follow_ups.forEach((item, index) => this.validateDue(item.due_at, `follow_ups.${index}.due_at`));
    try {
      const results = await this.services.followUps.create(
        parsed.follow_ups.map((item) => ({
          owner: this.owner(item.owner, state) ?? state.request.requestedBy,
          counterparty: item.counterparty,
          promise: item.promise,
          dueAt: item.due_at,
          notes: item.notes,
        })),
        {
          actor: state.request.requestedBy,
          groupName: state.request.groupName,
          messageId: state.request.messageId,
        },
      );
      for (const { followUp } of results) state.knownFollowUpIds.add(followUp.id);
      const lines = results.map(({ followUp, duplicate }) =>
        `${duplicate ? "♻️ already tracked:" : "•"} ${followUpLine(followUp, this.timezone)}`,
      );
      return final([`🤝 Tracking ${results.length} follow-up${results.length === 1 ? "" : "s"}:`, ...lines].join("\n"));
    } catch (error) {
      if (error instanceof FollowUpValidationError) return output({ error: `${error.message}. Fix it and retry.` });
      throw error;
    }
  }

  private async listFollowUps(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const parsed = listFollowUpsSchema.parse(args);
    this.validateDue(parsed.due_to, "due_to");
    const status = parsed.status ?? "open";
    const followUps = await this.services.followUps.list({
      statuses: status === "all" ? [...FOLLOW_UP_STATUSES] : [status],
      owner: this.owner(parsed.owner, state),
      counterparty: parsed.counterparty,
      dueTo: parsed.due_to,
      limit: parsed.limit ?? 20,
    });
    for (const followUp of followUps) state.knownFollowUpIds.add(followUp.id);
    return output({
      followUps: followUps.map((followUp) => ({
        ...followUp,
        ref: `F${followUp.id}`,
        due: followUp.dueAt ? formatDueForDisplay(followUp.dueAt, this.timezone) : null,
      })),
    });
  }

  private async updateFollowUps(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const parsed = updateFollowUpsSchema.parse(args);
    const blocked = this.unknown(
      parsed.updates.map((update) => update.follow_up_id),
      state.knownFollowUpIds,
      "F",
      "list_follow_ups",
    );
    if (blocked) return blocked;
    parsed.updates.forEach((update, index) => this.validateDue(update.due_at, `updates.${index}.due_at`));
    const lines: string[] = [];
    for (const update of parsed.updates) {
      const after = await this.services.followUps.update(
        update.follow_up_id,
        {
          status: update.status ?? null,
          dueAt: update.due_at,
          notes: update.notes,
          promise: update.promise,
        },
        state.request.requestedBy,
      );
      if (!after) {
        lines.push(`⚠️ F${update.follow_up_id} was not found.`);
      } else {
        const icon = after.status === "done" ? "🎉" : after.status === "dropped" ? "🗑️" : "✅";
        lines.push(`${icon} ${followUpLine(after, this.timezone)} — ${after.status}`);
      }
    }
    return final(lines.join("\n"));
  }

  private async createRecurring(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const parsed = createRecurringSchema.parse(args);
    if (parsed.frequency === "weekly" && !parsed.weekday) {
      throw new ToolArgumentError("weekly schedules need a weekday (1 = Monday … 7 = Sunday)");
    }
    try {
      const record = await this.services.recurring.create(
        {
          title: parsed.title,
          notes: parsed.notes,
          owner: this.owner(parsed.owner, state),
          area: parsed.area,
          priority: parsed.priority ?? null,
          rule: {
            frequency: parsed.frequency,
            every: parsed.every ?? 1,
            weekday: parsed.weekday ?? null,
            dayOfMonth: parsed.day_of_month ?? null,
          },
          startsOn: parsed.starts_on,
        },
        state.request.requestedBy,
      );
      state.knownRecurringIds.add(record.id);
      return final(
        `🔁 R${record.id} set up: ${record.title} — ${describeRule(record.rule)}${record.owner ? ` · owner ${record.owner}` : ""}. First task lands ${formatDueForDisplay(record.nextRunOn, this.timezone)}.`,
      );
    } catch (error) {
      if (error instanceof RecurringValidationError) return output({ error: `${error.message}. Fix it and retry.` });
      throw error;
    }
  }

  private async listRecurring(state: Phase1State): Promise<ToolOutcome> {
    const records = await this.services.recurring.list();
    for (const record of records) state.knownRecurringIds.add(record.id);
    return output({
      recurring: records.map((record: RecurringTaskRecord) => ({
        ref: `R${record.id}`,
        id: record.id,
        title: record.title,
        schedule: describeRule(record.rule),
        nextRunOn: record.nextRunOn,
        active: record.active,
        owner: record.owner,
      })),
    });
  }

  private async updateRecurring(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const parsed = updateRecurringSchema.parse(args);
    const blocked = this.unknown([parsed.recurring_id], state.knownRecurringIds, "R", "list_recurring_tasks");
    if (blocked) return blocked;
    const record = await this.services.recurring.setState(parsed.recurring_id, parsed.action, state.request.requestedBy);
    if (!record) return final(`⚠️ R${parsed.recurring_id} was not found.`);
    const verb = { pause: "⏸️ Paused", resume: "▶️ Resumed", delete: "🗑️ Deleted" }[parsed.action];
    const next = parsed.action === "resume" ? ` Next task lands ${formatDueForDisplay(record.nextRunOn, this.timezone)}.` : "";
    return final(`${verb} R${record.id} ${record.title}.${next}`);
  }

  private async addChecklist(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const parsed = addChecklistSchema.parse(args);
    const blocked = this.unknown([parsed.task_id], state.knownTaskIds, "#", "list_tasks");
    if (blocked) return blocked;
    const task = await this.tasks.get(parsed.task_id);
    if (!task) return final(`⚠️ Task #${parsed.task_id} was not found.`);
    const items = await this.services.checklists.add(task.id, parsed.items, state.request.requestedBy);
    return final(`☑️ Checklist on #${task.id} ${task.title}:\n${checklistLines(items)}`);
  }

  private async tickChecklist(args: unknown, state: Phase1State): Promise<ToolOutcome> {
    const parsed = tickChecklistSchema.parse(args);
    const blocked = this.unknown([parsed.task_id], state.knownTaskIds, "#", "list_tasks");
    if (blocked) return blocked;
    const task = await this.tasks.get(parsed.task_id);
    if (!task) return final(`⚠️ Task #${parsed.task_id} was not found.`);
    const { items, missing } = await this.services.checklists.setDone(
      task.id,
      parsed.item_numbers,
      parsed.done ?? true,
      state.request.requestedBy,
    );
    const warning = missing.length > 0 ? `\n⚠️ No item ${missing.join(", ")} on this checklist.` : "";
    const left = items.filter((item) => !item.done).length;
    return final(`☑️ #${task.id} ${task.title} — ${left === 0 ? "all items done" : `${left} left`}:\n${checklistLines(items)}${warning}`);
  }

  private async undo(state: Phase1State): Promise<ToolOutcome> {
    const result = await this.tasks.undoLast(state.request.requestedBy);
    if (!result) return final("Nothing of yours to undo from the last 24 hours.");
    const task = result.task;
    if (result.action !== "reverted") {
      return final(`↩️ Undone: ${result.action} #${task.id} ${task.title}.`);
    }
    this.logger.info({ taskId: task.id, fields: result.fields }, "Reverted a task change");
    return final(
      `↩️ Undone: #${task.id} ${task.title} is back to how it was${result.fields.length ? ` (${result.fields.join(", ").replace("due_at", "due date")})` : ""}.`,
    );
  }
}
