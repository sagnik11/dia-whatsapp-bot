import { CANDIDATE_CLEARABLE, DEAL_CLEARABLE } from "./admin-args.js";
import { CANDIDATE_STAGES } from "./candidate-store.js";
import { COMPLIANCE_AREAS, COMPLIANCE_RECURRENCES, COMPLIANCE_STATUSES } from "./compliance-store.js";
import type { ToolDefinition } from "./llm.js";
import { DEAL_STAGES } from "./pipeline-store.js";

const text = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const date = (description: string) => ({ type: "string", description: `${description} YYYY-MM-DD.` });
const amount = { type: "string", description: "Rupees as said, e.g. '120000', '1.2L', '2.5Cr', '40k'." };

const complianceFields = {
  name: text("The filing or renewal exactly as the CA or founder named it."),
  authority: text("Who it is filed with, as given (e.g. 'MCA', 'GSTN')."),
  area: { type: "string", enum: [...COMPLIANCE_AREAS], description: "Finance for tax and payroll; Legal otherwise." },
  due_on: date("The next due date as given."),
  recurrence: { type: "string", enum: [...COMPLIANCE_RECURRENCES], description: "Only when stated; default none." },
  owner: text("Founder responsible; 'me' means the sender."),
  lead_days: { type: "integer", minimum: 0, maximum: 365, description: "Days before due_on to add the task. Default 14." },
  checklist: { type: "array", items: { type: "string" }, description: "Documents or steps, as given." },
  notes: text(),
};

export const COMPLIANCE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "add_compliance_items",
    description:
      "Add filings and renewals to the compliance register (CO<id>), e.g. a list the CA sent. One item per obligation, only as provided; never add obligations nobody gave you.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: {
            type: "object",
            properties: complianceFields,
            required: ["name", "due_on"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "list_compliance",
    description: "List compliance items (CO<id>) due within N days, overdue ones first. Use before answering anything about filings.",
    parameters: {
      type: "object",
      properties: {
        within_days: { type: "integer", minimum: 1, maximum: 366, description: "Default 30." },
        include_overdue: { type: "boolean", description: "Default true." },
        status: { type: "string", enum: [...COMPLIANCE_STATUSES, "all"], description: "Default active." },
        owner: text(),
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_compliance",
    description:
      "Mark a period done (recurring items roll to the next due date, one-offs are archived), edit fields, or delete, by CO<id>. Use ids the founder named or that list_compliance returned in this request.",
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
              compliance_id: { type: "integer", minimum: 1 },
              action: { type: "string", enum: ["done", "edit", "delete"] },
              ...complianceFields,
              notes: text("Appended to existing notes."),
              status: { type: "string", enum: [...COMPLIANCE_STATUSES] },
            },
            required: ["compliance_id", "action"],
            additionalProperties: false,
          },
        },
      },
      required: ["updates"],
      additionalProperties: false,
    },
  },
];

export const METRIC_TOOLS: readonly ToolDefinition[] = [
  {
    name: "log_metrics",
    description:
      "Log KPIs a founder states ('MRR 1.2L, 3 pilots, 41 repos'): one entry per number. Pass the value exactly as said; Patch reads L/lakh/Cr/crore/k.",
    parameters: {
      type: "object",
      properties: {
        metrics: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              name: text("Short KPI name, e.g. 'mrr', 'pilots', 'repos'."),
              value: { type: "string", description: "As said, e.g. '3', '1.2L', '₹40k', '12%'." },
              unit: text("INR for money, % for percentages, otherwise a count noun or empty."),
              as_of: date("Date the number is for. Default today."),
              note: text(),
            },
            required: ["name", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["metrics"],
      additionalProperties: false,
    },
  },
  {
    name: "metric_trend",
    description: "One metric's values over time with the absolute and percent change. Use for any 'how has X moved' question.",
    parameters: {
      type: "object",
      properties: {
        name: text("KPI name as logged."),
        since: date("Start date. Default 180 days ago."),
        until: date("End date. Default today."),
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "latest_metrics",
    description: "The latest value of each metric (or the named ones) with the change since the value before it.",
    parameters: {
      type: "object",
      properties: { names: { type: "array", maxItems: 30, items: { type: "string" } } },
      additionalProperties: false,
    },
  },
];

function boardTools(input: {
  noun: string;
  plural: string;
  prefix: string;
  idField: string;
  listName: string;
  stages: readonly string[];
  clearable: readonly string[];
  fields: Record<string, unknown>;
  required: string;
  createHint: string;
}): ToolDefinition[] {
  const { noun, plural, prefix } = input;
  const listOf = (properties: Record<string, unknown>, required: string[]) => ({
    type: "array",
    minItems: 1,
    maxItems: 20,
    items: { type: "object", properties, required, additionalProperties: false },
  });
  return [
    {
      name: `create_${plural}`,
      description: `${input.createHint} Check ${input.listName} first; an open ${noun} with the same name comes back as a duplicate.`,
      parameters: {
        type: "object",
        properties: { [plural]: listOf(input.fields, [input.required]) },
        required: [plural],
        additionalProperties: false,
      },
    },
    {
      name: input.listName,
      description: `List ${plural} (${prefix}<id>) by stage and owner, flagged stuck, missing a next step, or with an overdue next step. Default: open stages.`,
      parameters: {
        type: "object",
        properties: {
          stage: { type: "string", enum: [...input.stages, "open", "all"] },
          owner: text(),
          text: text("Words in the name or contact/role."),
          flagged_only: { type: "boolean", description: "Only stuck, no-next-step or overdue items." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
    },
    {
      name: `update_${plural}`,
      description: `Move stage, set the next step, edit, clear fields, or delete ${plural} by ${prefix}<id>. Use ids the founder named or that ${input.listName} returned in this request.`,
      parameters: {
        type: "object",
        properties: {
          updates: listOf(
            {
              [input.idField]: { type: "integer", minimum: 1 },
              ...input.fields,
              notes: text("Appended to existing notes."),
              clear: { type: "array", items: { type: "string", enum: [...input.clearable] } },
              delete: { type: "boolean", description: "Only when a founder explicitly says delete or remove." },
            },
            [input.idField],
          ),
        },
        required: ["updates"],
        additionalProperties: false,
      },
    },
  ];
}

export const PIPELINE_TOOLS: readonly ToolDefinition[] = [
  ...boardTools({
    noun: "deal",
    plural: "deals",
    prefix: "P",
    idField: "deal_id",
    listName: "list_pipeline",
    stages: DEAL_STAGES,
    clearable: DEAL_CLEARABLE,
    required: "company",
    createHint: "Add leads, pilots or deals to the sales pipeline (P<id>), one per company.",
    fields: {
      company: text(),
      contact: text("Person at the company."),
      stage: { type: "string", enum: [...DEAL_STAGES], description: "Default lead." },
      value_inr: amount,
      next_step: text("The next concrete action, verb first."),
      next_step_at: date("When the next step is due."),
      owner: text("Founder responsible; 'me' means the sender."),
      notes: text(),
    },
  }),
  ...boardTools({
    noun: "candidate",
    plural: "candidates",
    prefix: "C",
    idField: "candidate_id",
    listName: "list_candidates",
    stages: CANDIDATE_STAGES,
    clearable: CANDIDATE_CLEARABLE,
    required: "name",
    createHint: "Add people to the hiring pipeline (C<id>), one per person and role.",
    fields: {
      name: text(),
      role: text("The role they are being considered for."),
      stage: { type: "string", enum: [...CANDIDATE_STAGES], description: "Default sourced." },
      next_action: text("The next concrete action, verb first."),
      next_action_at: date("When the next action is due."),
      owner: text("Founder responsible; 'me' means the sender."),
      notes: text(),
    },
  }),
];

export const INVESTOR_UPDATE_TOOL: ToolDefinition = {
  name: "draft_investor_update",
  description:
    "Draft the monthly investor update from stored data (tasks closed that month, metrics and their change, logged decisions, pipeline and hiring). Returns a DRAFT for the founders; nothing is sent.",
  parameters: {
    type: "object",
    properties: { month: { type: "string", description: "YYYY-MM. Default: last month." } },
    additionalProperties: false,
  },
};

export const ADMIN_TOOLS: readonly ToolDefinition[] = [
  ...COMPLIANCE_TOOLS,
  ...METRIC_TOOLS,
  ...PIPELINE_TOOLS,
  INVESTOR_UPDATE_TOOL,
];

export const ADMIN_INSTRUCTIONS: readonly string[] = [
  "Admin and ops (D1):",
  "- Compliance register (CO<id>): items come only from what the founders or their CA provide. Never invent, suggest, or assume a statutory obligation, authority, due date, form or penalty, and give no legal or tax advice. Use add_compliance_items for a pasted list (recurrence only when stated), list_compliance for what is due or overdue, and update_compliance to mark a period done, edit, or delete. Patch silently adds a task lead_days before each due date and never posts about compliance.",
  "- Metrics: log_metrics for numbers a founder states, one entry per number with the value exactly as said and unit INR for money. Answer metric questions with metric_trend or latest_metrics; never compute or guess numbers yourself.",
  "- Pipelines: deals (P<id>; lead, qualified, pilot, negotiation, won, lost) and candidates (C<id>; sourced, screen, interview, offer, hired, rejected). For an existing company or person, list first and update rather than create. Mention stuck items and missing next steps when listing.",
  "- draft_investor_update writes a DRAFT from stored data only. Never claim it was sent, and never add facts to it.",
  "- update_compliance, update_deals and update_candidates act only on ids the founder named or that a list call returned in this request.",
];
