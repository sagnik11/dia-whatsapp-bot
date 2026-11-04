import { z } from "zod";
import { CANDIDATE_STAGES } from "./candidate-store.js";
import { COMPLIANCE_AREAS, COMPLIANCE_RECURRENCES, COMPLIANCE_STATUSES } from "./compliance-store.js";
import { parseIndianNumber } from "./indian-number.js";
import { DEAL_STAGES } from "./pipeline-store.js";
import { isLocalDate } from "./recurring-store.js";

// Argument schemas for the admin and ops tools. Bad arguments throw ZodError,
// which the assistant returns to the model to fix.

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || null);

const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : value);

const id = z.coerce.number().int().positive();

export const dateArg = z
  .string()
  .trim()
  .transform((value) => (/^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value))
  .refine(isLocalDate, "must be a YYYY-MM-DD date");

const optionalDate = dateArg.nullish().transform((value) => value ?? null);

/** "1.2L", "₹40k", 120000 → a number; anything unreadable is an argument error. */
export const amountArg = z.union([z.number(), z.string()]).transform((value, context) => {
  const parsed = parseIndianNumber(value);
  if (parsed === null) {
    context.addIssue({ code: "custom", message: `"${value}" is not a number Patch can read (try 1.2L, 2.5Cr, 40k)` });
    return z.NEVER;
  }
  return parsed;
});

const optionalAmount = amountArg.nullish().transform((value) => value ?? null);

const area = z.preprocess(
  (value) => (typeof value === "string" ? `${value.trim().charAt(0).toUpperCase()}${value.trim().slice(1).toLowerCase()}` : value),
  z.enum(COMPLIANCE_AREAS).nullish(),
);

const checklist = z
  .union([z.string().max(4_000), z.array(z.string().max(300)).max(30)])
  .nullish()
  .transform((value) => (Array.isArray(value) ? value.map((line) => line.trim()).filter(Boolean).join("\n") : value?.trim()) || null);

const limit = z.coerce.number().int().min(1).max(100).nullish();

// --- Compliance -----------------------------------------------------------------

export const addComplianceSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        authority: optionalText(100),
        area,
        due_on: dateArg,
        recurrence: z.preprocess(lower, z.enum(COMPLIANCE_RECURRENCES).nullish()),
        owner: optionalText(100),
        lead_days: z.coerce.number().int().min(0).max(365).nullish(),
        checklist,
        notes: optionalText(2_000),
      }),
    )
    .min(1)
    .max(40),
});

export const listComplianceSchema = z.object({
  within_days: z.coerce.number().int().min(1).max(366).nullish(),
  include_overdue: z.boolean().nullish(),
  status: z.preprocess(lower, z.enum([...COMPLIANCE_STATUSES, "all"]).nullish()),
  owner: optionalText(100),
});

export const updateComplianceSchema = z.object({
  updates: z
    .array(
      z.object({
        compliance_id: id,
        action: z.preprocess(lower, z.enum(["done", "edit", "delete"])),
        name: optionalText(200),
        authority: optionalText(100),
        area,
        due_on: optionalDate,
        recurrence: z.preprocess(lower, z.enum(COMPLIANCE_RECURRENCES).nullish()),
        owner: optionalText(100),
        lead_days: z.coerce.number().int().min(0).max(365).nullish(),
        checklist,
        notes: optionalText(2_000),
        status: z.preprocess(lower, z.enum(COMPLIANCE_STATUSES).nullish()),
      }),
    )
    .min(1)
    .max(20),
});

// --- Metrics --------------------------------------------------------------------

export const logMetricsSchema = z.object({
  metrics: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        value: z.union([z.number(), z.string().trim().min(1).max(40)]),
        unit: optionalText(20),
        as_of: optionalDate,
        note: optionalText(500),
      }),
    )
    .min(1)
    .max(30),
});

export const metricTrendSchema = z.object({
  name: z.string().trim().min(1).max(60),
  since: optionalDate,
  until: optionalDate,
});

export const latestMetricsSchema = z.object({
  names: z.array(z.string().trim().min(1).max(60)).max(30).nullish(),
});

// --- Pipelines ------------------------------------------------------------------

export const DEAL_CLEARABLE = ["contact", "value_inr", "next_step", "next_step_at", "owner"] as const;
export const CANDIDATE_CLEARABLE = ["role", "next_action", "next_action_at", "owner"] as const;

export const createDealsSchema = z.object({
  deals: z
    .array(
      z.object({
        company: z.string().trim().min(1).max(120),
        contact: optionalText(120),
        stage: z.preprocess(lower, z.enum(DEAL_STAGES).nullish()),
        value_inr: optionalAmount,
        next_step: optionalText(300),
        next_step_at: optionalDate,
        owner: optionalText(100),
        notes: optionalText(2_000),
      }),
    )
    .min(1)
    .max(20),
});

export const updateDealsSchema = z.object({
  updates: z
    .array(
      z.object({
        deal_id: id,
        company: optionalText(120),
        contact: optionalText(120),
        stage: z.preprocess(lower, z.enum(DEAL_STAGES).nullish()),
        value_inr: optionalAmount,
        next_step: optionalText(300),
        next_step_at: optionalDate,
        owner: optionalText(100),
        notes: optionalText(2_000),
        clear: z.array(z.preprocess(lower, z.enum(DEAL_CLEARABLE))).max(5).nullish(),
        delete: z.boolean().nullish(),
      }),
    )
    .min(1)
    .max(20),
});

export const createCandidatesSchema = z.object({
  candidates: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        role: optionalText(120),
        stage: z.preprocess(lower, z.enum(CANDIDATE_STAGES).nullish()),
        next_action: optionalText(300),
        next_action_at: optionalDate,
        owner: optionalText(100),
        notes: optionalText(2_000),
      }),
    )
    .min(1)
    .max(20),
});

export const updateCandidatesSchema = z.object({
  updates: z
    .array(
      z.object({
        candidate_id: id,
        name: optionalText(120),
        role: optionalText(120),
        stage: z.preprocess(lower, z.enum(CANDIDATE_STAGES).nullish()),
        next_action: optionalText(300),
        next_action_at: optionalDate,
        owner: optionalText(100),
        notes: optionalText(2_000),
        clear: z.array(z.preprocess(lower, z.enum(CANDIDATE_CLEARABLE))).max(4).nullish(),
        delete: z.boolean().nullish(),
      }),
    )
    .min(1)
    .max(20),
});

export const listBoardSchema = (stages: readonly [string, ...string[]]) =>
  z.object({
    stage: z.preprocess(lower, z.enum([...stages, "open", "all"]).nullish()),
    owner: optionalText(100),
    text: optionalText(120),
    flagged_only: z.boolean().nullish(),
    limit,
  });

export const investorUpdateSchema = z.object({
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "must be a YYYY-MM month")
    .nullish()
    .transform((value) => value ?? null),
});
