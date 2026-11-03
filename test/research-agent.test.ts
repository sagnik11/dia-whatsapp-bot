import { describe, expect, it, vi } from "vitest";
import { ResearchAgent } from "../src/research-agent.js";
import { textTurn, toolTurn } from "./support/fake-llm.js";

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
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        toolTurn("search-1", "search_web", {
          query: "official Hacker News launch guidance",
          topic: "general",
        }),
      )
      .mockResolvedValueOnce(
        textTurn(
          "## Summary\nUse a factual Show HN post. https://news.ycombinator.com/newsguidelines.html",
        ),
      );
    const agent = new ResearchAgent({
      llm: { complete },
      timezone: "Asia/Kolkata",
      maxSearches: 3,
      webSearch: { search } as never,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
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
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      toolChoice: { name: "search_web" },
    });
    expect(complete.mock.calls[1]?.[0].messages).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "search-1" }),
    );
  });

  it("withdraws the search tool once the budget is spent so the model must write", async () => {
    const search = vi.fn().mockResolvedValue({ query: "q", results: [] });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(toolTurn("s1", "search_web", { query: "first query", topic: "general" }))
      .mockResolvedValueOnce(textTurn("## Summary\nNot enough public evidence."));
    const agent = new ResearchAgent({
      llm: { complete },
      timezone: "Asia/Kolkata",
      maxSearches: 1,
      webSearch: { search } as never,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
    });

    await agent.run({ question: "Anything?", context: null, requestedBy: "Tanvi" });
    expect(complete.mock.calls[1]?.[0].tools).toEqual([]);
  });
});
