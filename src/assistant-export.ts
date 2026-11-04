import { z } from "zod";
import { toCsvBuffer, type CsvCell } from "./csv.js";
import type { ToolDefinition } from "./llm.js";
import type { Logger } from "./logger.js";
import type { ToolModule, ToolSession } from "./tool-module.js";
import { final, output, type ToolOutcome } from "./tool-outcome.js";
import type { AssistantRequest } from "./types.js";

/** Hard cap on rows in one export, whatever the model asks for. */
export const EXPORT_MAX_ROWS = 500;
/** At most this many files are attached to one reply. */
export const EXPORT_MAX_FILES_PER_REQUEST = 3;

/** Rows loaded by an export source, ready to serialize. */
export interface ExportTable {
  /** What was exported, used in the confirmation and the file name, e.g. "open tasks". */
  label: string;
  columns: readonly string[];
  rows: ReadonlyArray<readonly CsvCell[]>;
  /** True when more rows matched than were included. */
  truncated: boolean;
}

export interface ExportContext {
  request: AssistantRequest;
  /** Row cap for this export, already clamped to EXPORT_MAX_ROWS. */
  limit: number;
  timezone: string;
}

/** A dataset export_csv can produce. Any module can register more. */
export interface ExportSource {
  /** Dataset key the model passes as `dataset`, e.g. "tasks". */
  readonly name: string;
  /** One line telling the model what the dataset holds and which filters apply. */
  readonly description: string;
  /**
   * JSON Schema properties for this dataset's filters, merged into export_csv's
   * parameters. When two sources declare the same property the first one wins,
   * so reuse COMMON_EXPORT_FILTERS for shared names.
   */
  readonly filters?: Readonly<Record<string, unknown>>;
  /** Parse this dataset's filters from the tool arguments and load the rows. */
  load(args: unknown, context: ExportContext): Promise<ExportTable>;
}

/** Filter properties shared by several datasets, so they read the same to the model. */
export const COMMON_EXPORT_FILTERS = {
  statuses: {
    type: "array",
    items: { type: "string" },
    description:
      "Only these statuses. Tasks: todo, in_progress, blocked, done, cancelled. Follow-ups: open, done, dropped. Omit for open rows.",
  },
  include_closed: {
    type: "boolean",
    description: "Include done, cancelled and dropped rows (for 'all tasks'). Default false.",
  },
  owner: { type: "string", description: "Owner name as the founder said it; 'me' means the sender." },
  text: { type: "string", description: "Words to find in titles or notes." },
} as const;

const DATASET_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** Export sources keyed by dataset name. */
export class ExportRegistry {
  private readonly sources = new Map<string, ExportSource>();

  public register(...sources: readonly ExportSource[]): this {
    for (const source of sources) {
      if (!DATASET_NAME.test(source.name)) {
        throw new Error(`Export dataset name "${source.name}" must be lower_snake_case`);
      }
      if (this.sources.has(source.name)) {
        throw new Error(`Export dataset "${source.name}" is already registered`);
      }
      this.sources.set(source.name, source);
    }
    return this;
  }

  public get(name: string): ExportSource | undefined {
    return this.sources.get(name);
  }

  public list(): ExportSource[] {
    return [...this.sources.values()];
  }

  public get names(): string[] {
    return [...this.sources.keys()];
  }
}

export function isExportRequest(message: string): boolean {
  return /\b(?:export|csv|spreadsheet|excel|xlsx)\b/i.test(message);
}

export const EXPORT_INSTRUCTIONS: readonly string[] = [
  "CSV export: use export_csv when a founder asks to export or download data, or asks for a CSV, spreadsheet or Excel file of tasks, follow-ups or a task's checklist.",
  "- Pass only the filters the founder gave; 'all tasks' means include_closed true. Patch sends the file as a WhatsApp document and confirms it, so never paste the rows into the chat.",
];

const argsSchema = z.object({
  dataset: z.string().trim().min(1).max(40).transform((value) => value.toLowerCase()),
  limit: z.coerce.number().int().min(1).max(EXPORT_MAX_ROWS).nullish(),
});

function exportTool(sources: readonly ExportSource[]): ToolDefinition {
  const filters: Record<string, unknown> = {};
  for (const source of sources) {
    for (const [key, schema] of Object.entries(source.filters ?? {})) {
      if (!(key in filters) && key !== "dataset" && key !== "limit") filters[key] = schema;
    }
  }
  return {
    name: "export_csv",
    description: [
      "Send data as a CSV file (opens in Excel or Google Sheets) attached to the reply as a WhatsApp document. Read-only.",
      ...sources.map((source) => `Dataset ${source.name}: ${source.description}`),
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        dataset: { type: "string", enum: sources.map((source) => source.name) },
        ...filters,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: EXPORT_MAX_ROWS,
          description: `Row cap. Default ${EXPORT_MAX_ROWS}.`,
        },
      },
      required: ["dataset"],
      additionalProperties: false,
    },
  };
}

/** Today's date in the group's timezone, as YYYY-MM-DD. */
export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** e.g. "open tasks" on 4 Nov 2026 → patch-open-tasks-2026-11-04.csv */
export function exportFileName(label: string, now: Date, timezone: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `patch-${slug || "export"}-${localDate(now, timezone)}.csv`;
}

/** The export_csv tool, backed by a registry of datasets other modules can extend. */
export class ExportTools implements ToolModule {
  public readonly name = "export";
  public readonly instructions = EXPORT_INSTRUCTIONS;
  public readonly registry = new ExportRegistry();

  public constructor(
    sources: readonly ExportSource[],
    private readonly timezone: string,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.registry.register(...sources);
  }

  /** Rebuilt on every read so datasets registered later show up. */
  public get tools(): readonly ToolDefinition[] {
    const sources = this.registry.list();
    return sources.length > 0 ? [exportTool(sources)] : [];
  }

  public detect(message: string): boolean {
    return this.registry.list().length > 0 && isExportRequest(message);
  }

  public begin(request: AssistantRequest): ToolSession {
    const state = { files: 0 };
    return {
      handle: async (name, args) =>
        name === "export_csv" ? this.export(args, request, state) : null,
    };
  }

  private async export(
    args: unknown,
    request: AssistantRequest,
    state: { files: number },
  ): Promise<ToolOutcome> {
    const parsed = argsSchema.parse(args);
    const source = this.registry.get(parsed.dataset);
    if (!source) {
      return output({
        error: `Unknown dataset "${parsed.dataset}". Use one of: ${this.registry.names.join(", ")}.`,
      });
    }
    if (state.files >= EXPORT_MAX_FILES_PER_REQUEST) {
      return output({
        error: `Only ${EXPORT_MAX_FILES_PER_REQUEST} files can be attached to one reply. Tell the founder to ask again for the rest.`,
      });
    }
    const limit = Math.min(parsed.limit ?? EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
    const table = await source.load(args, { request, limit, timezone: this.timezone });
    const rows = table.rows.slice(0, limit);
    if (rows.length === 0) return final(`📭 Nothing to export for ${table.label}.`);

    state.files += 1;
    const fileName = exportFileName(table.label, this.now(), this.timezone);
    const truncated = table.truncated || table.rows.length > rows.length;
    this.logger.info(
      { dataset: source.name, rows: rows.length, truncated, fileName },
      "Exported CSV",
    );
    const text = [
      `📎 Exported ${rows.length} row${rows.length === 1 ? "" : "s"} of ${table.label} as ${fileName}.`,
      ...(truncated
        ? [`⚠️ Only the first ${rows.length} rows are included; narrow the filters for the rest.`]
        : []),
    ].join("\n");
    return final(text, [
      { fileName, mimeType: "text/csv", data: toCsvBuffer(table.columns, rows) },
    ]);
  }
}
