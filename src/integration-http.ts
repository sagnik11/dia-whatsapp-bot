import type { z } from "zod";
import { output, type ToolOutcome } from "./tool-outcome.js";

/** A failed call to Google, GitHub or Sentry, safe to show to a founder (no tokens). */
export class IntegrationError extends Error {
  public constructor(
    public readonly service: string,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export interface JsonRequestInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** Objects are sent as JSON; strings and URLSearchParams as-is. */
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function apiMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  const candidates = [
    error && typeof error === "object" ? (error as Record<string, unknown>).message : null,
    record.error_description,
    typeof error === "string" ? error : null,
    record.message,
    record.detail,
  ];
  const found = candidates.find((value): value is string => typeof value === "string" && value.trim() !== "");
  return found ? found.trim().replace(/\s+/g, " ").slice(0, 200) : null;
}

function statusHint(service: string, status: number): string {
  if (status === 401) return `${service} rejected the credentials`;
  if (status === 403) return `${service} denied access (the token may lack a scope or the repo/project permission)`;
  if (status === 404) return `${service} could not find that item`;
  if (status === 409) return `${service} reported a conflict`;
  if (status === 429) return `${service} is rate limiting Patch; try again in a few minutes`;
  if (status >= 500) return `${service} is having trouble (HTTP ${status}); try again later`;
  return `${service} refused the request (HTTP ${status})`;
}

/** fetch with a timeout; returns parsed JSON (null for empty bodies) or throws IntegrationError. */
export async function fetchJson(service: string, url: string, init: JsonRequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json", ...init.headers };
  let body: string | undefined;
  if (typeof init.body === "string") body = init.body;
  else if (init.body instanceof URLSearchParams) {
    body = init.body.toString();
    headers["Content-Type"] ??= "application/x-www-form-urlencoded";
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] ??= "application/json";
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new IntegrationError(service, timedOut ? `${service} did not answer in time` : `Could not reach ${service}`);
  }
  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (response.ok) throw new IntegrationError(service, `${service} returned a response Patch could not read`);
    }
  }
  if (!response.ok) {
    const detail = apiMessage(payload);
    throw new IntegrationError(
      service,
      `${statusHint(service, response.status)}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  return payload;
}

/** Validates an API response, turning a shape mismatch into a readable IntegrationError. */
export function parseResponse<T>(service: string, schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new IntegrationError(service, `${service} returned an unexpected response`);
  return parsed.data;
}

/** Maps integration failures to a tool output the model relays; anything else is rethrown. */
export function integrationFailure(error: unknown, action: string): ToolOutcome {
  if (error instanceof IntegrationError) {
    return output({ error: `${action} failed: ${error.message}. Nothing else was changed. Tell the founder plainly.` });
  }
  throw error;
}
