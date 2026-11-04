/**
 * The small slice of each Cloudflare binding the Patch API Worker uses.
 * Declared locally so the Worker needs no @cloudflare/workers-types, and so
 * tests can pass plain fakes. The real bindings satisfy these shapes.
 */

export type D1Value = string | number | boolean | null;

export interface D1MetaLike {
  changes?: number;
  last_row_id?: number | null;
  duration?: number;
  rows_read?: number;
  rows_written?: number;
}

export interface D1ResultLike {
  results?: Array<Record<string, unknown>>;
  success?: boolean;
  meta?: D1MetaLike;
}

export interface D1PreparedStatementLike {
  bind(...values: D1Value[]): D1PreparedStatementLike;
  /** D1 treats all() and run() alike; all() also returns RETURNING rows. */
  all(): Promise<D1ResultLike>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

export type VectorMetadataValue = string | number | boolean;
export type VectorMetadata = Record<string, VectorMetadataValue>;

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface VectorQueryOptions {
  topK: number;
  filter: Record<string, unknown>;
  returnMetadata: "none" | "indexed" | "all";
  returnValues: boolean;
}

export interface VectorMatchLike {
  id: string;
  score: number;
  metadata?: Record<string, unknown> | null;
}

export interface VectorizeIndexLike {
  /** Resolves with `{ mutationId }` on Vectorize V2; writes become queryable a few seconds later. */
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(vector: number[], options: VectorQueryOptions): Promise<{ matches: VectorMatchLike[] }>;
}

export interface R2HttpMetadataLike {
  contentType?: string;
}

export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  httpMetadata?: R2HttpMetadataLike;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream;
}

export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream,
    options: { httpMetadata: R2HttpMetadataLike },
  ): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
}

export interface AiRunOptions {
  gateway?: { id: string };
}

export interface AiLike {
  run(model: string, inputs: Record<string, unknown>, options?: AiRunOptions): Promise<unknown>;
}

export interface Env {
  DB: D1DatabaseLike;
  VECTORS: VectorizeIndexLike;
  FILES: R2BucketLike;
  AI: AiLike;
  /** Worker secret shared with the bot (`wrangler secret put PATCH_API_TOKEN`). */
  PATCH_API_TOKEN?: string;
  /** Optional AI Gateway id so embedding calls show up next to chat traffic. */
  AI_GATEWAY_ID?: string;
}
