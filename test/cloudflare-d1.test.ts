import { describe, expect, it, vi } from "vitest";
import { D1HttpClient, D1QueryError } from "../src/cloudflare-d1.js";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(fetchImpl: typeof fetch) {
  return new D1HttpClient({
    accountId: "acct-123",
    databaseId: "db-456",
    apiToken: "d1-token",
    fetch: fetchImpl,
    logger: { warn: vi.fn() } as never,
  });
}

describe("D1HttpClient", () => {
  it("posts one parameterized statement to the D1 query endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        success: true,
        errors: [],
        messages: [],
        result: [
          {
            success: true,
            results: [{ id: 7, title: "Ship it" }],
            meta: { changes: 1, last_row_id: 7, duration: 0.4 },
          },
        ],
      }),
    );

    const result = await client(fetchMock as unknown as typeof fetch).query(
      "SELECT id, title FROM tasks WHERE id = ?",
      [7],
    );

    expect(result).toEqual({ results: [{ id: 7, title: "Ship it" }], changes: 1, lastRowId: 7 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/d1/database/db-456/query",
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer d1-token");
    expect(JSON.parse(String(init.body))).toEqual({
      sql: "SELECT id, title FROM tasks WHERE id = ?",
      params: [7],
    });
  });

  it("surfaces D1 error messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        { success: false, errors: [{ code: 7500, message: "no such table: tasks" }], result: null },
        400,
      ),
    );
    await expect(
      client(fetchMock as unknown as typeof fetch).query("SELECT 1 FROM tasks"),
    ).rejects.toThrow(new D1QueryError("D1 query failed (400): no such table: tasks", 400));
  });

  it("retries a rate-limited statement because it never executed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ success: false, errors: [] }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(json({ success: true, errors: [], result: [{ results: [] }] }));
    await expect(
      client(fetchMock as unknown as typeof fetch).query("SELECT 1"),
    ).resolves.toEqual({ results: [], changes: 0, lastRowId: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a server error, which may already have applied a write", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ success: false, errors: [{ message: "internal" }] }, 500));
    await expect(
      client(fetchMock as unknown as typeof fetch).query("UPDATE tasks SET title = ?", ["x"]),
    ).rejects.toBeInstanceOf(D1QueryError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
