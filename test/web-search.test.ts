import { afterEach, describe, expect, it, vi } from "vitest";
import { TavilyWebSearchService } from "../src/web-search.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TavilyWebSearchService", () => {
  it("performs one bounded basic search and returns compact sources", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          query: "Autter code assurance",
          results: [
            {
              title: "Autter",
              url: "https://autter.dev/",
              content: "Autter reviews and verifies pull requests.",
              score: 0.99,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new TavilyWebSearchService({
      apiKey: "tvly-test",
      logger: { info: vi.fn() } as never,
    });

    const result = await service.search({
      query: "Autter code assurance",
      topic: "general",
    });

    expect(result.results).toEqual([
      {
        title: "Autter",
        url: "https://autter.dev/",
        content: "Autter reviews and verifies pull requests.",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer tvly-test" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      query: "Autter code assurance",
      topic: "general",
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
    });
  });
});
