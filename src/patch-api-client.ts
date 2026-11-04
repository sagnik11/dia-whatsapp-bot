import { z } from "zod";
import {
  postD1Query,
  type D1QueryTransport,
  type SqlExecutor,
  type SqlResult,
  type SqlValue,
} from "./cloudflare-d1.js";
import type { Logger } from "./logger.js";
import { zonedParts } from "./time.js";
import type { AssistantAttachment } from "./types.js";

/** Clients for the Patch API Worker (worker/src/index.ts). */
export interface PatchApiOptions {
  /** e.g. https://patch-api.<account>.workers.dev */
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  logger: Logger;
}

export class PatchApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PatchApiError";
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

const envelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).default([]),
  result: z.unknown(),
});

async function readEnvelope(response: Response, what: string): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = envelopeSchema.safeParse(body);
  if (!response.ok || !parsed.success || !parsed.data.success) {
    const messages = parsed.success ? parsed.data.errors.map((error) => error.message).join("; ") : "";
    throw new PatchApiError(
      `Patch API ${what} failed (${response.status}): ${messages || response.statusText || "unexpected response"}`,
      response.status,
    );
  }
  return parsed.data.result;
}

class PatchApiHttp {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: PatchApiOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  public request(path: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.token}`);
    return this.fetchImpl(endpoint(this.options.baseUrl, path), {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs ?? this.options.timeoutMs ?? 15_000),
    });
  }

  public async postJson(path: string, body: unknown, what: string): Promise<unknown> {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return readEnvelope(response, what);
  }
}

// --- D1 ----------------------------------------------------------------------

/**
 * Runs every D1 statement through the Worker's D1 binding. The Worker
 * answers in D1's REST shape, so parsing and 429 retries are shared with
 * D1HttpClient.
 */
export class PatchApiSqlExecutor implements SqlExecutor {
  private readonly transport: D1QueryTransport;

  public constructor(options: PatchApiOptions & { maxRetries?: number }) {
    this.transport = {
      endpoint: endpoint(options.baseUrl, "/d1/query"),
      apiToken: options.token,
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

// --- Vectors -----------------------------------------------------------------

export type SemanticMetadata = {
  group_id: string;
  kind: string;
  ref: string;
} & Record<string, string | number | boolean>;

export interface SemanticItem {
  /** Stable and idempotent, e.g. `memory:12` or `task:7`. At most 64 bytes. */
  id: string;
  text: string;
  metadata: SemanticMetadata;
}

export interface SemanticMatch {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface SemanticQuery {
  text: string;
  /** Required: results are this group's items plus company-wide ones. */
  groupId: string;
  kind?: string | null;
  topK: number;
}

const upsertResultSchema = z.object({ upserted: z.number() });
const queryResultSchema = z.object({
  matches: z.array(
    z.object({
      id: z.string(),
      score: z.number(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
    }),
  ),
});

/** Items per request; the Worker embeds them in smaller batches. */
const UPSERT_CHUNK = 100;

export class SemanticIndex {
  private readonly http: PatchApiHttp;

  public constructor(options: PatchApiOptions) {
    this.http = new PatchApiHttp({ ...options, timeoutMs: options.timeoutMs ?? 60_000 });
  }

  public async upsert(items: readonly SemanticItem[]): Promise<number> {
    let upserted = 0;
    for (let start = 0; start < items.length; start += UPSERT_CHUNK) {
      const result = await this.http.postJson(
        "/vectors/upsert",
        { items: items.slice(start, start + UPSERT_CHUNK) },
        "vector upsert",
      );
      upserted += upsertResultSchema.parse(result).upserted;
    }
    return upserted;
  }

  public async query(query: SemanticQuery): Promise<SemanticMatch[]> {
    const result = await this.http.postJson(
      "/vectors/query",
      {
        text: query.text,
        group_id: query.groupId,
        ...(query.kind ? { kind: query.kind } : {}),
        topK: query.topK,
      },
      "vector query",
    );
    return queryResultSchema
      .parse(result)
      .matches.map((match) => ({ id: match.id, score: match.score, metadata: match.metadata ?? {} }));
  }
}

// --- Files -------------------------------------------------------------------

function filePath(key: string): string {
  return `/files/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export class FileArchive {
  private readonly http: PatchApiHttp;

  public constructor(options: PatchApiOptions) {
    this.http = new PatchApiHttp({ ...options, timeoutMs: options.timeoutMs ?? 120_000 });
  }

  public async put(key: string, data: Uint8Array, contentType: string): Promise<void> {
    const response = await this.http.request(filePath(key), {
      method: "PUT",
      headers: {
        "content-type": contentType || "application/octet-stream",
        "content-length": String(data.byteLength),
      },
      body: new Blob([new Uint8Array(data)]),
    });
    await readEnvelope(response, "file upload");
  }

  public async get(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
    const response = await this.http.request(filePath(key), { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) await readEnvelope(response, "file download");
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  public async delete(key: string): Promise<void> {
    const response = await this.http.request(filePath(key), { method: "DELETE" });
    if (!response.ok) await readEnvelope(response, "file delete");
  }
}

// --- Attachment archive ------------------------------------------------------

function safeSegment(value: string, maxLength: number): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9@._-]+/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, maxLength);
  return cleaned || "_";
}

/** `<groupId>/<YYYY>/<MM>/<messageId>-<fileName>`, month in the founders' timezone. */
export function attachmentArchiveKey(input: {
  groupId: string;
  messageId: string;
  fileName: string;
  sentAtMs: number;
  timezone: string;
}): string {
  const parts = zonedParts(new Date(input.sentAtMs), input.timezone);
  const year = String(parts.year ?? 1970).padStart(4, "0");
  const month = String(parts.month ?? 1).padStart(2, "0");
  return [
    safeSegment(input.groupId, 120),
    year,
    month,
    `${safeSegment(input.messageId, 200)}-${safeSegment(input.fileName, 150)}`,
  ].join("/");
}

export interface ArchiveAttachmentInput {
  groupId: string;
  messageId: string;
  sentAtMs: number;
  attachment: Pick<AssistantAttachment, "fileName" | "mimeType" | "dataBase64">;
}

/** Stores one ingested attachment in R2 and returns its key. */
export function createAttachmentArchiver(
  archive: Pick<FileArchive, "put">,
  timezone: string,
): (input: ArchiveAttachmentInput) => Promise<string> {
  return async (input) => {
    const key = attachmentArchiveKey({
      groupId: input.groupId,
      messageId: input.messageId,
      fileName: input.attachment.fileName,
      sentAtMs: input.sentAtMs,
      timezone,
    });
    await archive.put(key, Buffer.from(input.attachment.dataBase64, "base64"), input.attachment.mimeType);
    return key;
  };
}
