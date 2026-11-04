import { vi } from "vitest";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON when the body was JSON, otherwise the raw string. */
  body: unknown;
}

export type RouteHandler = (request: RecordedRequest) => unknown;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Stubs global fetch with method + URL-pattern routes. A handler returns a
 * Response, or any value that is sent as a 200 JSON body. Unmatched requests
 * get a 404 so a missing route shows up as a test failure, not a hang.
 */
export function routeFetch(routes: ReadonlyArray<[method: string, pattern: RegExp, handler: RouteHandler]>) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init.method ?? "GET").toUpperCase();
    let body: unknown = typeof init.body === "string" ? init.body : undefined;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // form-encoded or text bodies stay strings
      }
    }
    const request = { method, url, headers: Object.fromEntries(new Headers(init.headers).entries()), body };
    requests.push(request);
    const route = routes.find(([routeMethod, pattern]) => routeMethod === method && pattern.test(url));
    if (!route) return jsonResponse(404, { error: { message: `no test route for ${method} ${url}` } });
    const result = route[2](request);
    return result instanceof Response ? result : jsonResponse(200, result);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    requests,
    fetchMock,
    /** Requests whose method and URL match, e.g. to assert something was never sent. */
    matching: (method: string, pattern: RegExp) =>
      requests.filter((request) => request.method === method && pattern.test(request.url)),
  };
}
