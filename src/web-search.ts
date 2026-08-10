import { z } from "zod";
import type { Logger } from "./logger.js";

const tavilyResponseSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.url(),
      content: z.string(),
      score: z.number().optional(),
    }),
  ),
});

export interface WebSearchInput {
  query: string;
  topic: "general" | "news";
}

export interface WebSearchResult {
  query: string;
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}

interface TavilyWebSearchOptions {
  apiKey: string;
  logger: Logger;
}

export class TavilyWebSearchService {
  public constructor(private readonly options: TavilyWebSearchOptions) {}

  public async search(input: WebSearchInput): Promise<WebSearchResult> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: input.query,
        topic: input.topic,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Tavily search failed with HTTP ${response.status}`);
    }

    const parsed = tavilyResponseSchema.parse(await response.json());
    const results = parsed.results.slice(0, 5).map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content.slice(0, 1_200),
    }));

    this.options.logger.info(
      { query: input.query, resultCount: results.length, topic: input.topic },
      "Searched the web",
    );

    return { query: parsed.query, results };
  }
}
