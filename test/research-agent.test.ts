import { describe, expect, it, vi } from "vitest";
import { ResearchAgent } from "../src/research-agent.js";

describe("ResearchAgent", () => {
  it("uses focused searches and returns a cited bounded report", async () => {
    const search = vi.fn().mockResolvedValue({
      query: "official Hacker News launch guidance",
      results: [
        {
          title: "Hacker News Guidelines",
          url: "https://news.ycombinator.com/newsguidelines.html",
          content: "Community submission guidelines.",
        },
      ],
    });
    const responsesCreate = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: "function_call",
            name: "search_web",
            call_id: "search-1",
            arguments: JSON.stringify({
              query: "official Hacker News launch guidance",
              topic: "general",
            }),
          },
        ],
        output_text: "",
      })
      .mockResolvedValueOnce({
        output: [],
        output_text:
          "## Summary\nUse a factual Show HN post. https://news.ycombinator.com/newsguidelines.html",
      });
    const agent = new ResearchAgent({
      gatewayApiKey: "test-key",
      gatewayBaseUrl: "https://example.com/v1",
      model: "azure/test-model",
      timezone: "Asia/Kolkata",
      maxSearches: 3,
      webSearch: { search } as never,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
    });
    Object.assign(agent as unknown as { client: unknown }, {
      client: { responses: { create: responsesCreate } },
    });

    const result = await agent.run({
      question: "Where should Autter launch?",
      context: "Developer audience",
      requestedBy: "Sagnik",
    });

    expect(result.searchesUsed).toBe(1);
    expect(result.report).toContain("https://news.ycombinator.com/");
    expect(result.sources).toEqual([
      {
        title: "Hacker News Guidelines",
        url: "https://news.ycombinator.com/newsguidelines.html",
      },
    ]);
    expect(search).toHaveBeenCalledOnce();
    expect(responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: "function", name: "search_web" },
    });
  });
});
