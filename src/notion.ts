import {
  Client,
  type PageObjectResponse,
  type SearchResponse,
} from "@notionhq/client";
import type { Logger } from "./logger.js";
import type {
  BrainDumpAppendInput,
  BrainDumpAppendResult,
  BrainDumpResult,
  KnowledgeResourceResult,
  KnowledgeSearchResponse,
  NoteSource,
  ScriptLibraryResult,
  ScriptSource,
} from "./types.js";

function escapeMarkdownInline(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&");
}

export function brainDumpAppendMarkdown(
  input: BrainDumpAppendInput,
  source: NoteSource,
): string {
  const heading = input.heading?.trim();
  return [
    "",
    `## ${heading || "WhatsApp note"}`,
    "",
    input.content.trim(),
    "",
    `_Added from WhatsApp · ${escapeMarkdownInline(source.groupName)} · ${escapeMarkdownInline(source.requestedBy)}_`,
  ].join("\n");
}

interface NotionWorkspaceServiceOptions {
  apiKey: string;
  brainDumpPageId?: string;
  knowledgeEnabled?: boolean;
  scriptSources?: ReadonlyArray<ScriptSource>;
  scriptSeriesName?: string;
  logger: Logger;
}

const MAX_BRAIN_DUMP_CHARACTERS = 12_000;
const MAX_KNOWLEDGE_PAGE_CHARACTERS = 12_000;
const MAX_NOTION_MARKDOWN_CHUNK_CHARACTERS = 100_000;

type NotionSearchItem = SearchResponse["results"][number];
type NotionPageProperty = PageObjectResponse["properties"][string];

function plainText(
  items: ReadonlyArray<{ plain_text: string }>,
  maxCharacters = 400,
): string {
  return items.map((item) => item.plain_text).join("").trim().slice(0, maxCharacters);
}

function searchItemTitle(item: NotionSearchItem): string {
  if (item.object === "page" && "properties" in item) {
    const title = Object.values(item.properties).find(
      (property) => property.type === "title",
    );
    return title?.type === "title" ? plainText(title.title) : "";
  }

  if (item.object === "data_source" && "title" in item) {
    return plainText(item.title);
  }

  return "";
}

function scriptEpisodeNumber(title: string, seriesName: string): number | null {
  const escapedSeries = seriesName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = title.match(
    new RegExp(`^${escapedSeries}\\s+Ep(?:isode)?\\.?\\s*(\\d+)\\s*$`, "i"),
  );
  if (!match?.[1]) return null;
  const episode = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(episode) && episode > 0 ? episode : null;
}

function summarizePageProperty(property: NotionPageProperty): unknown {
  switch (property.type) {
    case "title":
      return plainText(property.title);
    case "rich_text":
      return plainText(property.rich_text);
    case "number":
      return property.number;
    case "select":
      return property.select?.name ?? null;
    case "multi_select":
      return property.multi_select.slice(0, 20).map((option) => option.name);
    case "status":
      return property.status?.name ?? null;
    case "date":
      return property.date;
    case "checkbox":
      return property.checkbox;
    case "url":
      return property.url;
    case "email":
      return property.email;
    case "phone_number":
      return property.phone_number;
    case "people":
      return property.people.slice(0, 10).map((person) =>
        "name" in person && person.name ? person.name : person.id,
      );
    case "created_time":
      return property.created_time;
    case "last_edited_time":
      return property.last_edited_time;
    case "created_by":
      return "name" in property.created_by && property.created_by.name
        ? property.created_by.name
        : property.created_by.id;
    case "last_edited_by":
      return "name" in property.last_edited_by && property.last_edited_by.name
        ? property.last_edited_by.name
        : property.last_edited_by.id;
    case "relation":
      return property.relation.slice(0, 10).map((relation) => relation.id);
    case "unique_id":
      return `${property.unique_id.prefix ?? ""}${property.unique_id.number}`;
    default:
      return undefined;
  }
}

function summarizePageProperties(
  properties: PageObjectResponse["properties"],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(properties).slice(0, 20).flatMap(([name, property]) => {
      const value = summarizePageProperty(property);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export function boundBrainDumpMarkdown(markdown: string): {
  markdown: string;
  truncated: boolean;
} {
  if (markdown.length <= MAX_BRAIN_DUMP_CHARACTERS) {
    return { markdown, truncated: false };
  }

  return {
    markdown: `${markdown.slice(0, MAX_BRAIN_DUMP_CHARACTERS)}\n\n[Content truncated by Captain Patch]`,
    truncated: true,
  };
}

/**
 * Keep each Notion Markdown request comfortably below the API payload limit
 * while preserving the complete document and preferring Markdown boundaries.
 */
export function splitMarkdownForNotion(
  markdown: string,
  maxCharacters = MAX_NOTION_MARKDOWN_CHUNK_CHARACTERS,
): string[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("maxCharacters must be a positive integer");
  }
  if (markdown.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;
  while (markdown.length - start > maxCharacters) {
    const hardEnd = start + maxCharacters;
    const minimumPreferredEnd = start + Math.floor(maxCharacters / 2);
    const paragraphEnd = markdown.lastIndexOf("\n\n", hardEnd - 2);
    const lineEnd = markdown.lastIndexOf("\n", hardEnd - 1);
    const whitespaceEnd = markdown.lastIndexOf(" ", hardEnd - 1);
    let end = hardEnd;
    if (paragraphEnd >= minimumPreferredEnd) end = paragraphEnd + 2;
    else if (lineEnd >= minimumPreferredEnd) end = lineEnd + 1;
    else if (whitespaceEnd >= minimumPreferredEnd) end = whitespaceEnd + 1;

    // Do not separate a UTF-16 surrogate pair at a hard boundary.
    const previousCodeUnit = markdown.charCodeAt(end - 1);
    const nextCodeUnit = markdown.charCodeAt(end);
    if (
      previousCodeUnit >= 0xd800 &&
      previousCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff
    ) {
      end -= 1;
    }

    chunks.push(markdown.slice(start, end));
    start = end;
  }
  chunks.push(markdown.slice(start));
  return chunks;
}

/**
 * Notion access is limited to the Brain Dump page plus the optional,
 * read-only knowledge and script readers. Tasks live in Cloudflare D1.
 */
export class NotionWorkspaceService {
  private readonly client: Client;

  public constructor(private readonly options: NotionWorkspaceServiceOptions) {
    this.client = new Client({ auth: options.apiKey });
  }

  public get canReadBrainDump(): boolean {
    return Boolean(this.options.brainDumpPageId);
  }

  public get canReadKnowledge(): boolean {
    return Boolean(this.options.knowledgeEnabled);
  }

  public get canReadScriptLibrary(): boolean {
    return Boolean(this.options.scriptSources?.length);
  }

  public async readScriptLibrary(): Promise<ScriptLibraryResult> {
    const sources = this.options.scriptSources ?? [];
    const seriesName = this.options.scriptSeriesName?.trim() || "Dekhte Hai";
    if (sources.length === 0) {
      throw new Error("NOTION_SCRIPT_SOURCE_MAP_JSON is not configured");
    }

    const queryResults = await Promise.all(
      sources.map(async (source) => ({
        source,
        response: await this.client.dataSources.query({
          data_source_id: source.dataSourceId,
          page_size: 100,
          result_type: "page",
          filter: {
            property: source.titleProperty,
            title: { contains: seriesName },
          },
          sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        }),
      })),
    );

    const newestByEpisode = new Map<
      number,
      { episode: number; page: PageObjectResponse; title: string }
    >();
    for (const { source, response } of queryResults) {
      for (const result of response.results) {
        if (result.object !== "page" || !("properties" in result)) continue;
        const page = result as PageObjectResponse;
        const property = page.properties[source.titleProperty];
        const title = property?.type === "title" ? plainText(property.title) : "";
        const episode = scriptEpisodeNumber(title, seriesName);
        if (episode === null) continue;
        const current = newestByEpisode.get(episode);
        if (!current || page.last_edited_time > current.page.last_edited_time) {
          newestByEpisode.set(episode, { episode, page, title });
        }
      }
    }

    const matches = [...newestByEpisode.values()]
      .sort((left, right) => left.episode - right.episode);
    const scripts = (
      await Promise.all(
        matches.map(async ({ episode, page, title }) => {
          try {
            const content = await this.client.pages.retrieveMarkdown({
              page_id: page.id,
              include_transcript: false,
            });
            return {
              episode,
              id: page.id,
              title,
              url: page.url,
              lastEditedTime: page.last_edited_time,
              markdown: content.markdown,
              truncated: content.truncated,
            };
          } catch (error) {
            this.options.logger.warn(
              { error, notionPageId: page.id, title },
              "Could not read one Notion script page",
            );
            return null;
          }
        }),
      )
    ).filter((script): script is NonNullable<typeof script> => script !== null);

    this.options.logger.info(
      {
        seriesName,
        sourceCount: sources.length,
        scriptCount: scripts.length,
        episodes: scripts.map((script) => script.episode),
      },
      "Read live Notion script library",
    );
    return { seriesName, scripts };
  }

  public async searchKnowledge(
    query: string,
    limit: number,
  ): Promise<KnowledgeSearchResponse> {
    if (!this.canReadKnowledge) {
      throw new Error("NOTION_KNOWLEDGE_ENABLED is not enabled");
    }

    const response = await this.client.search({
      query,
      page_size: limit,
      sort: { property: "relevance" },
      filter: { in_trash: false },
    });
    const results = response.results.flatMap((item) => {
      const title = searchItemTitle(item);
      if (!title) return [];
      return [
        {
          id: item.id,
          type: item.object,
          title,
          url: "url" in item && typeof item.url === "string" ? item.url : null,
          lastEditedTime:
            "last_edited_time" in item &&
            typeof item.last_edited_time === "string"
              ? item.last_edited_time
              : null,
        },
      ];
    });

    this.options.logger.info(
      { resultCount: results.length, hasMore: response.has_more },
      "Searched Notion knowledge",
    );
    return { results, hasMore: response.has_more };
  }

  public async readKnowledgeResource(
    id: string,
    type: "page" | "data_source",
  ): Promise<KnowledgeResourceResult> {
    if (!this.canReadKnowledge) {
      throw new Error("NOTION_KNOWLEDGE_ENABLED is not enabled");
    }

    if (type === "page") {
      const response = await this.client.pages.retrieveMarkdown({
        page_id: id,
        include_transcript: false,
      });
      const bounded =
        response.markdown.length <= MAX_KNOWLEDGE_PAGE_CHARACTERS
          ? { markdown: response.markdown, truncated: false }
          : {
              markdown: `${response.markdown.slice(0, MAX_KNOWLEDGE_PAGE_CHARACTERS)}\n\n[Notion page truncated by Captain Patch]`,
              truncated: true,
            };
      const truncated = response.truncated || bounded.truncated;

      this.options.logger.info(
        { notionPageId: id, characters: bounded.markdown.length, truncated },
        "Read Notion knowledge page",
      );
      return { id, type, markdown: bounded.markdown, truncated };
    }

    const response = await this.client.dataSources.query({
      data_source_id: id,
      page_size: 5,
      result_type: "page",
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });
    const rows = response.results
      .filter(
        (result): result is PageObjectResponse =>
          result.object === "page" && "properties" in result,
      )
      .map((page) => ({
        id: page.id,
        url: page.url,
        lastEditedTime: page.last_edited_time,
        properties: summarizePageProperties(page.properties),
      }));

    this.options.logger.info(
      { notionDataSourceId: id, rowCount: rows.length, hasMore: response.has_more },
      "Read Notion knowledge data source",
    );
    return { id, type, rows, hasMore: response.has_more };
  }

  public async readBrainDump(): Promise<BrainDumpResult> {
    const pageId = this.options.brainDumpPageId;
    if (!pageId) {
      throw new Error("NOTION_BRAIN_DUMP_PAGE_ID is not configured");
    }

    const response = await this.client.pages.retrieveMarkdown({
      page_id: pageId,
      include_transcript: false,
    });
    const bounded = boundBrainDumpMarkdown(response.markdown);
    const truncated = response.truncated || bounded.truncated;

    this.options.logger.info(
      { notionPageId: pageId, characters: bounded.markdown.length, truncated },
      "Read Notion Brain Dump",
    );

    return { pageId, markdown: bounded.markdown, truncated };
  }

  public async appendBrainDump(
    input: BrainDumpAppendInput,
    source: NoteSource,
  ): Promise<BrainDumpAppendResult> {
    const pageId = this.options.brainDumpPageId;
    if (!pageId) {
      throw new Error("NOTION_BRAIN_DUMP_PAGE_ID is not configured");
    }

    const markdown = brainDumpAppendMarkdown(input, source);
    const chunks = splitMarkdownForNotion(markdown);
    for (const chunk of chunks) {
      await this.client.pages.updateMarkdown({
        page_id: pageId,
        type: "insert_content",
        insert_content: {
          content: chunk,
          position: { type: "end" },
        },
      });
    }

    this.options.logger.info(
      {
        notionPageId: pageId,
        charactersAdded: markdown.length,
        chunksAdded: chunks.length,
        hasHeading: Boolean(input.heading),
      },
      "Appended to Notion Brain Dump",
    );

    return {
      pageId,
      heading: input.heading,
      charactersAdded: markdown.length,
    };
  }
}
