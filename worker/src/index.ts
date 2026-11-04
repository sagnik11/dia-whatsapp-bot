/**
 * Patch API Worker: D1 over a binding (same request and response shape as
 * D1's REST query endpoint), semantic memory in Vectorize, and an R2
 * attachment archive. Every route requires `Authorization: Bearer <token>`.
 *
 * Handlers are plain functions that take the bindings as parameters so
 * vitest can drive them in Node with fakes.
 */
import type {
  AiLike,
  D1DatabaseLike,
  D1Value,
  Env,
  R2BucketLike,
  VectorMetadata,
  VectorRecord,
} from "./bindings.js";

export type { Env } from "./bindings.js";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;
/** Tasks are company-wide: indexed under this group and included in every query. */
export const COMPANY_WIDE_GROUP = "*";

const EMBED_BATCH_SIZE = 50;
const MAX_UPSERT_ITEMS = 200;
/** Well under bge-m3's 8,192-token window. */
const MAX_EMBED_CHARACTERS = 6_000;
const MAX_QUERY_CHARACTERS = 2_000;
const MAX_TOP_K = 20;
const MAX_VECTOR_ID_BYTES = 64;
const MAX_METADATA_BYTES = 8 * 1_024;
const MAX_FILE_BYTES = 25 * 1_024 * 1_024;
const MAX_KEY_BYTES = 1_024;
const D1_ERROR_CODE = 7500;

type EmbeddingEnv = Pick<Env, "AI" | "VECTORS" | "AI_GATEWAY_ID">;

interface VectorItem {
  id: string;
  text: string;
  metadata: VectorMetadata;
}

export class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly code = 10000,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// --- Helpers -------------------------------------------------------------------

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Cloudflare's API envelope, which D1HttpClient already knows how to read. */
function failure(
  status: number,
  message: string,
  code = 10000,
  headers: Record<string, string> = {},
): Response {
  return json({ success: false, errors: [{ code, message }], messages: [], result: null }, status, headers);
}

function ok(result: unknown, status = 200): Response {
  return json({ success: true, errors: [], messages: [], result }, status);
}

/** Compares SHA-256 digests byte by byte so timing reveals neither length nor prefix. */
export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < x.length; index += 1) {
    difference |= (x[index] ?? 0) ^ (y[index] ?? 0);
  }
  return difference === 0;
}

export async function isAuthorized(header: string | null, token: string): Promise<boolean> {
  const presented = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "")?.[1] ?? "";
  // Always hash and compare, even for a missing header, so the timing is uniform.
  const matches = await constantTimeEqual(presented, token);
  return matches && presented.length > 0;
}

// --- D1 -------------------------------------------------------------------------

function isD1Value(value: unknown): value is D1Value {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * POST /d1/query with `{sql, params}`. Runs one statement through the D1
 * binding and answers in the REST API's shape:
 * `{success, errors, messages, result: [{success, results, meta}]}`.
 */
export async function handleD1Query(body: unknown, db: D1DatabaseLike): Promise<Response> {
  if (!isRecord(body) || typeof body.sql !== "string" || !body.sql.trim()) {
    return failure(400, "Body must be {sql, params}", D1_ERROR_CODE);
  }
  const params = body.params ?? [];
  if (!Array.isArray(params) || !params.every(isD1Value)) {
    return failure(400, "params must be an array of strings, numbers, booleans or nulls", D1_ERROR_CODE);
  }
  try {
    const statement = db.prepare(body.sql);
    const result = await (params.length > 0 ? statement.bind(...params) : statement).all();
    return ok([
      {
        success: true,
        results: result.results ?? [],
        meta: {
          changes: result.meta?.changes ?? 0,
          last_row_id: result.meta?.last_row_id ?? null,
          duration: result.meta?.duration ?? 0,
          rows_read: result.meta?.rows_read ?? 0,
          rows_written: result.meta?.rows_written ?? 0,
        },
      },
    ]);
  } catch (error) {
    const message = errorMessage(error);
    // An overloaded database rejects the statement before running it, so the
    // client may retry it like the REST API's 429.
    const overloaded = /overloaded|queued for too long/i.test(message);
    return failure(overloaded ? 429 : 400, message, D1_ERROR_CODE, overloaded ? { "retry-after": "1" } : {});
  }
}

// --- Vectors ----------------------------------------------------------------------

/** Embeds texts with bge-m3, optionally through AI Gateway. */
export async function embedTexts(ai: AiLike, texts: readonly string[], gatewayId?: string): Promise<number[][]> {
  const output = await ai.run(
    EMBEDDING_MODEL,
    { text: [...texts] },
    gatewayId ? { gateway: { id: gatewayId } } : {},
  );
  const data = isRecord(output) ? output.data : undefined;
  if (
    !Array.isArray(data) ||
    data.length !== texts.length ||
    !data.every(
      (vector): vector is number[] =>
        Array.isArray(vector) &&
        vector.length === EMBEDDING_DIMENSIONS &&
        vector.every((value) => typeof value === "number"),
    )
  ) {
    throw new HttpError(502, `${EMBEDDING_MODEL} returned an unexpected embedding shape`);
  }
  return data;
}

function parseMetadata(value: unknown, path: string): VectorMetadata {
  if (!isRecord(value)) throw new HttpError(400, `${path} must be an object`);
  const metadata: VectorMetadata = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    if (
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      metadata[key] = entry;
    } else {
      throw new HttpError(400, `${path}.${key} must be a string, number or boolean`);
    }
  }
  for (const required of ["group_id", "kind", "ref"]) {
    const entry = metadata[required];
    if (typeof entry !== "string" || !entry.trim()) {
      throw new HttpError(400, `${path}.${required} must be a non-empty string`);
    }
  }
  if (byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
    throw new HttpError(400, `${path} is larger than ${MAX_METADATA_BYTES} bytes`);
  }
  return metadata;
}

function parseUpsertItems(body: unknown): VectorItem[] {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length === 0) {
    throw new HttpError(400, "Body must be {items: [{id, text, metadata}]} with at least one item");
  }
  if (body.items.length > MAX_UPSERT_ITEMS) {
    throw new HttpError(400, `At most ${MAX_UPSERT_ITEMS} items per request`);
  }
  const byId = new Map<string, VectorItem>();
  body.items.forEach((raw: unknown, index) => {
    const path = `items[${index}]`;
    if (!isRecord(raw)) throw new HttpError(400, `${path} must be an object`);
    const { id, text } = raw;
    if (typeof id !== "string" || !id.trim() || byteLength(id) > MAX_VECTOR_ID_BYTES) {
      throw new HttpError(400, `${path}.id must be 1-${MAX_VECTOR_ID_BYTES} bytes`);
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new HttpError(400, `${path}.text must be a non-empty string`);
    }
    // The same id twice in one request: the later one wins, as upsert would.
    byId.set(id, {
      id,
      text: text.trim().slice(0, MAX_EMBED_CHARACTERS),
      metadata: parseMetadata(raw.metadata, `${path}.metadata`),
    });
  });
  return [...byId.values()];
}

/**
 * POST /vectors/upsert with `{items: [{id, text, metadata: {group_id, kind, ref, ...}}]}`.
 * Embeds in batches and upserts, so re-sending an id replaces its vector.
 */
export async function handleVectorUpsert(body: unknown, env: EmbeddingEnv): Promise<Response> {
  const items = parseUpsertItems(body);
  const mutationIds: string[] = [];
  for (let start = 0; start < items.length; start += EMBED_BATCH_SIZE) {
    const batch = items.slice(start, start + EMBED_BATCH_SIZE);
    const embeddings = await embedTexts(env.AI, batch.map((item) => item.text), env.AI_GATEWAY_ID);
    const vectors: VectorRecord[] = batch.map((item, index) => ({
      id: item.id,
      values: embeddings[index] ?? [],
      metadata: item.metadata,
    }));
    const result = await env.VECTORS.upsert(vectors);
    if (isRecord(result) && typeof result.mutationId === "string") mutationIds.push(result.mutationId);
  }
  return ok({ upserted: items.length, mutationIds });
}

/**
 * POST /vectors/query with `{text, group_id, kind?, topK}`. Always filtered to
 * the caller's group plus company-wide items, in the query and again on the
 * way out, so one group's memory can never surface in another.
 */
export async function handleVectorQuery(body: unknown, env: EmbeddingEnv): Promise<Response> {
  if (!isRecord(body)) throw new HttpError(400, "Body must be {text, group_id, kind?, topK?}");
  const { text, group_id: groupId, kind } = body;
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text must be a non-empty string");
  if (typeof groupId !== "string" || !groupId.trim()) {
    throw new HttpError(400, "group_id is required: every vector query is scoped to one group");
  }
  if (kind !== undefined && kind !== null && (typeof kind !== "string" || !kind.trim())) {
    throw new HttpError(400, "kind must be a non-empty string when given");
  }
  const topK = body.topK === undefined || body.topK === null ? 5 : Number(body.topK);
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw new HttpError(400, `topK must be an integer from 1 to ${MAX_TOP_K}`);
  }

  const groups = [...new Set([groupId, COMPANY_WIDE_GROUP])];
  const filter: Record<string, unknown> = { group_id: { $in: groups } };
  if (typeof kind === "string") filter.kind = { $eq: kind };
  const [vector] = await embedTexts(env.AI, [text.trim().slice(0, MAX_QUERY_CHARACTERS)], env.AI_GATEWAY_ID);
  const result = await env.VECTORS.query(vector ?? [], {
    topK,
    filter,
    returnMetadata: "all",
    returnValues: false,
  });
  const matches = result.matches
    .filter((match) => {
      const metadata = match.metadata ?? {};
      return (
        typeof metadata.group_id === "string" &&
        groups.includes(metadata.group_id) &&
        (typeof kind !== "string" || metadata.kind === kind)
      );
    })
    .map((match) => ({ id: match.id, score: match.score, metadata: match.metadata ?? {} }));
  return ok({ matches });
}

// --- Files ----------------------------------------------------------------------

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The R2 key from `/files/<key>`; segments may be percent-encoded. Null when unsafe. */
export function parseFileKey(pathname: string): string | null {
  if (!pathname.startsWith("/files/")) return null;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice("/files/".length));
  } catch {
    return null;
  }
  const segments = key.split("/");
  if (
    !key ||
    byteLength(key) > MAX_KEY_BYTES ||
    hasControlCharacters(key) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return key;
}

/** PUT /files/:key streams the body to R2 with its content type. Needs Content-Length. */
export async function handleFilePut(request: Request, key: string, files: R2BucketLike): Promise<Response> {
  const declared = request.headers.get("content-length");
  const length = Number(declared);
  if (declared === null || !Number.isInteger(length) || length < 0) {
    return failure(411, "Content-Length is required");
  }
  if (length === 0 || !request.body) return failure(400, "The file is empty");
  if (length > MAX_FILE_BYTES) return failure(413, `Files are limited to ${MAX_FILE_BYTES} bytes`);
  const contentType = request.headers.get("content-type")?.trim() || "application/octet-stream";
  const object = await files.put(key, request.body, { httpMetadata: { contentType } });
  return ok({ key, size: object?.size ?? length, etag: object?.etag ?? null }, 201);
}

/** GET /files/:key streams the object back with its stored content type. */
export async function handleFileGet(key: string, files: R2BucketLike): Promise<Response> {
  const object = await files.get(key);
  if (!object) return failure(404, "File not found");
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      etag: object.httpEtag,
    },
  });
}

/** DELETE /files/:key. Deleting a missing key also succeeds. */
export async function handleFileDelete(key: string, files: R2BucketLike): Promise<Response> {
  await files.delete(key);
  return new Response(null, { status: 204 });
}

// --- Router ---------------------------------------------------------------------

async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

function methodNotAllowed(allowed: string): Response {
  return failure(405, `Use ${allowed}`, 10000, { allow: allowed });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const token = env.PATCH_API_TOKEN?.trim();
  if (!token) return failure(500, "The PATCH_API_TOKEN secret is not set on this Worker");
  if (!(await isAuthorized(request.headers.get("authorization"), token))) {
    return failure(401, "Missing or invalid bearer token", 10000, { "www-authenticate": "Bearer" });
  }

  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/d1/query") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await handleD1Query(await readJson(request), env.DB);
    }
    if (pathname === "/vectors/upsert") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await handleVectorUpsert(await readJson(request), env);
    }
    if (pathname === "/vectors/query") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await handleVectorQuery(await readJson(request), env);
    }
    if (pathname.startsWith("/files/")) {
      const key = parseFileKey(pathname);
      if (!key) return failure(400, "Invalid file key");
      switch (request.method) {
        case "PUT":
          return await handleFilePut(request, key, env.FILES);
        case "GET":
          return await handleFileGet(key, env.FILES);
        case "DELETE":
          return await handleFileDelete(key, env.FILES);
        default:
          return methodNotAllowed("PUT, GET, DELETE");
      }
    }
    return failure(404, "Not found");
  } catch (error) {
    if (error instanceof HttpError) return failure(error.status, error.message, error.code);
    console.error("Patch API request failed", { pathname, error: errorMessage(error) });
    return failure(502, `Upstream binding failed: ${errorMessage(error)}`);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
