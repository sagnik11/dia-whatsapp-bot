import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Logger } from "./logger.js";

export type SqlValue = string | number | null;

export interface SqlResult<Row> {
  results: Row[];
  changes: number;
  lastRowId: number | null;
}

/** Minimal SQL surface shared by Cloudflare D1 and the local test double. */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<SqlResult<Row>>;
}

const d1ResponseSchema = z.object({
  success: z.boolean(),
  errors: z
    .array(z.object({ code: z.number().optional(), message: z.string() }).passthrough())
    .default([]),
  result: z
    .array(
      z
        .object({
          success: z.boolean().optional(),
          results: z.array(z.record(z.string(), z.unknown())).default([]),
          meta: z
            .object({
              changes: z.number().optional(),
              last_row_id: z.number().nullable().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    )
    .nullable()
    .default([]),
});

export class D1QueryError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "D1QueryError";
  }
}

/** Where and how to POST `{sql, params}` and read back a D1 REST-shaped reply. */
export interface D1QueryTransport {
  endpoint: string;
  apiToken: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch: typeof fetch;
  logger: Logger;
}

/** Turns a D1 REST response (Cloudflare's or the Patch API Worker's) into rows. */
export async function parseD1Response<Row>(response: Response): Promise<SqlResult<Row>> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = d1ResponseSchema.safeParse(body);
  if (!response.ok || !parsed.success || !parsed.data.success) {
    const messages = parsed.success
      ? parsed.data.errors.map((error) => error.message).join("; ")
      : "Unexpected D1 response shape";
    throw new D1QueryError(
      `D1 query failed (${response.status}): ${messages || response.statusText}`,
      response.status,
    );
  }

  const statement = parsed.data.result?.[0];
  if (!statement) return { results: [], changes: 0, lastRowId: null };
  if (statement.success === false) {
    throw new D1QueryError("D1 statement reported failure", response.status);
  }
  return {
    results: statement.results as Row[],
    changes: statement.meta?.changes ?? 0,
    lastRowId: statement.meta?.last_row_id ?? null,
  };
}

/** Runs one parameterized statement over HTTP, retrying only rate limits. */
export async function postD1Query<Row>(
  transport: D1QueryTransport,
  sql: string,
  params: readonly SqlValue[],
): Promise<SqlResult<Row>> {
  const maxRetries = transport.maxRetries ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    const response = await transport.fetch(transport.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${transport.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(transport.timeoutMs ?? 15_000),
    });

    // 429 means the statement was rejected before execution, so a retry
    // cannot double-apply a write.
    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1_000, 5_000)
        : 250 * 2 ** attempt;
      transport.logger.warn({ attempt, waitMs }, "D1 rate limited; retrying");
      await delay(waitMs);
      continue;
    }

    return parseD1Response<Row>(response);
  }
}

interface D1HttpClientOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  logger: Logger;
}

/**
 * Cloudflare D1 over the REST API, for processes that run outside a Worker.
 * Each call runs one parameterized statement.
 */
export class D1HttpClient implements SqlExecutor {
  private readonly transport: D1QueryTransport;

  public constructor(options: D1HttpClientOptions) {
    const base = (options.apiBaseUrl ?? "https://api.cloudflare.com/client/v4").replace(
      /\/+$/,
      "",
    );
    this.transport = {
      endpoint: `${base}/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/query`,
      apiToken: options.apiToken,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      fetch: options.fetch ?? fetch,
      logger: options.logger,
    };
  }

  public query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<SqlResult<Row>> {
    return postD1Query<Row>(this.transport, sql, params);
  }
}
