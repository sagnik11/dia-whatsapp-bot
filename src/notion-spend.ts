import { createHash } from "node:crypto";
import { Client, type PageObjectResponse } from "@notionhq/client";
import type { Logger } from "./logger.js";
import type {
  SpendBatchResult,
  SpendInput,
  SpendListResult,
  SpendQuery,
  SpendSource,
  SpendSummary,
  SpendWriteResult,
} from "./types.js";

interface NotionSpendServiceOptions {
  apiKey: string;
  dataSourceId: string;
  payerMap: Readonly<Record<string, string>>;
  logger: Logger;
}

const PROPERTIES = {
  title: "Spend",
  amount: "Amount",
  category: "Category",
  date: "Date",
  notes: "Notes",
  paidBy: "Paid by",
  paymentMethod: "Payment method",
  reimbursable: "Reimbursable",
  vendor: "Vendor",
} as const;

type SpendFilter =
  | { property: string; people: { contains: string } }
  | { property: string; select: { equals: string } }
  | { property: string; date: { on_or_after: string } }
  | { property: string; date: { on_or_before: string } };

function text(items: ReadonlyArray<{ plain_text: string }>): string {
  return items.map((item) => item.plain_text).join("").trim();
}

function property(page: PageObjectResponse, name: string) {
  return page.properties[name];
}

function spendSummaryFromPage(page: PageObjectResponse): SpendSummary {
  const title = property(page, PROPERTIES.title);
  const amount = property(page, PROPERTIES.amount);
  const date = property(page, PROPERTIES.date);
  const paidBy = property(page, PROPERTIES.paidBy);
  const category = property(page, PROPERTIES.category);
  const paymentMethod = property(page, PROPERTIES.paymentMethod);
  const vendor = property(page, PROPERTIES.vendor);
  const notes = property(page, PROPERTIES.notes);
  const reimbursable = property(page, PROPERTIES.reimbursable);

  return {
    id: page.id,
    url: page.url,
    spend: title?.type === "title" ? text(title.title) : "Untitled spend",
    amount: amount?.type === "number" ? (amount.number ?? 0) : 0,
    date: date?.type === "date" ? (date.date?.start ?? null) : null,
    paidBy:
      paidBy?.type === "people"
        ? paidBy.people.map((person) =>
            "name" in person && person.name ? person.name : person.id,
          )
        : [],
    category:
      category?.type === "select" ? (category.select?.name ?? null) : null,
    paymentMethod:
      paymentMethod?.type === "select"
        ? (paymentMethod.select?.name ?? null)
        : null,
    vendor: vendor?.type === "rich_text" ? text(vendor.rich_text) || null : null,
    notes: notes?.type === "rich_text" ? text(notes.rich_text) || null : null,
    reimbursable:
      reimbursable?.type === "checkbox" ? reimbursable.checkbox : false,
  };
}

function idempotencyReference(messageId: string, index: number): string {
  const hash = createHash("sha256")
    .update(`${messageId}:${index}`)
    .digest("hex")
    .slice(0, 24);
  return `[Patch ref: ${hash}]`;
}

export class NotionSpendService {
  private readonly client: Client;

  public constructor(private readonly options: NotionSpendServiceOptions) {
    this.client = new Client({ auth: options.apiKey });
  }

  private resolvePayerId(name: string): string {
    const normalized = name.trim().toLowerCase();
    const raw = this.options.payerMap[normalized];
    if (!raw) {
      throw new Error(
        `No Notion payer mapping is configured for ${name}. Add it to NOTION_SPEND_PAYER_MAP_JSON.`,
      );
    }
    return raw.replace(/^user:\/\//i, "");
  }

  public async addSpends(
    spends: readonly SpendInput[],
    source: SpendSource,
  ): Promise<SpendBatchResult> {
    const payerIds = new Map<string, string>();
    for (const spend of spends) {
      if (!payerIds.has(spend.paidBy)) {
        payerIds.set(spend.paidBy, this.resolvePayerId(spend.paidBy));
      }
    }

    const results: SpendWriteResult[] = [];
    for (const [index, spend] of spends.entries()) {
      const reference = idempotencyReference(source.messageId, index);
      try {
        const duplicate = await this.client.dataSources.query({
          data_source_id: this.options.dataSourceId,
          filter: {
            property: PROPERTIES.notes,
            rich_text: { contains: reference },
          },
          page_size: 1,
        });
        const existing = duplicate.results.find(
          (result): result is PageObjectResponse =>
            result.object === "page" && "properties" in result,
        );
        if (existing) {
          results.push({
            index,
            spend: spend.spend,
            amount: spend.amount,
            date: spend.date,
            status: "duplicate",
            id: existing.id,
            url: existing.url,
            error: null,
          });
          continue;
        }

        const notes = [spend.notes?.trim(), reference].filter(Boolean).join("\n");
        const created = await this.client.pages.create({
          parent: {
            type: "data_source_id",
            data_source_id: this.options.dataSourceId,
          },
          properties: {
            [PROPERTIES.title]: {
              type: "title",
              title: [{ type: "text", text: { content: spend.spend } }],
            },
            [PROPERTIES.amount]: { type: "number", number: spend.amount },
            [PROPERTIES.category]: {
              type: "select",
              select: { name: spend.category },
            },
            [PROPERTIES.date]: {
              type: "date",
              date: { start: spend.date },
            },
            [PROPERTIES.notes]: {
              type: "rich_text",
              rich_text: [{ type: "text", text: { content: notes } }],
            },
            [PROPERTIES.paidBy]: {
              type: "people",
              people: [{ id: payerIds.get(spend.paidBy)! }],
            },
            [PROPERTIES.paymentMethod]: {
              type: "select",
              select: spend.paymentMethod ? { name: spend.paymentMethod } : null,
            },
            [PROPERTIES.reimbursable]: {
              type: "checkbox",
              checkbox: spend.reimbursable,
            },
            [PROPERTIES.vendor]: {
              type: "rich_text",
              rich_text: spend.vendor
                ? [{ type: "text", text: { content: spend.vendor } }]
                : [],
            },
          },
        });
        results.push({
          index,
          spend: spend.spend,
          amount: spend.amount,
          date: spend.date,
          status: "created",
          id: created.id,
          url: "url" in created ? created.url : null,
          error: null,
        });
      } catch (error) {
        this.options.logger.warn(
          { error, index, spend: spend.spend, messageId: source.messageId },
          "Could not add spend-log entry",
        );
        results.push({
          index,
          spend: spend.spend,
          amount: spend.amount,
          date: spend.date,
          status: "failed",
          id: null,
          url: null,
          error: "Notion rejected this entry.",
        });
      }
    }

    const created = results.filter((result) => result.status === "created");
    const uniquePayers = [...new Set(spends.map((spend) => spend.paidBy))];
    const result = {
      paidBy: uniquePayers.join(", "),
      results,
      createdCount: created.length,
      duplicateCount: results.filter((item) => item.status === "duplicate").length,
      failedCount: results.filter((item) => item.status === "failed").length,
      createdAmount: created.reduce((total, item) => total + item.amount, 0),
    };
    this.options.logger.info(
      {
        createdCount: result.createdCount,
        duplicateCount: result.duplicateCount,
        failedCount: result.failedCount,
        createdAmount: result.createdAmount,
        requestedBy: source.requestedBy,
      },
      "Updated Notion founder spend log",
    );
    return result;
  }

  public async listSpends(query: SpendQuery): Promise<SpendListResult> {
    const filters: SpendFilter[] = [];
    if (query.paidBy) {
      filters.push({
        property: PROPERTIES.paidBy,
        people: { contains: this.resolvePayerId(query.paidBy) },
      });
    }
    if (query.category) {
      filters.push({
        property: PROPERTIES.category,
        select: { equals: query.category },
      });
    }
    if (query.dateFrom) {
      filters.push({
        property: PROPERTIES.date,
        date: { on_or_after: query.dateFrom },
      });
    }
    if (query.dateTo) {
      filters.push({
        property: PROPERTIES.date,
        date: { on_or_before: query.dateTo },
      });
    }

    const response = await this.client.dataSources.query({
      data_source_id: this.options.dataSourceId,
      ...(filters.length === 1
        ? { filter: filters[0]! }
        : filters.length > 1
          ? { filter: { and: filters } }
          : {}),
      sorts: [{ property: PROPERTIES.date, direction: "descending" }],
      page_size: query.limit,
    });
    const spends = response.results
      .filter(
        (result): result is PageObjectResponse =>
          result.object === "page" && "properties" in result,
      )
      .map(spendSummaryFromPage);
    const result = {
      spends,
      hasMore: response.has_more,
      totalAmount: spends.reduce((total, spend) => total + spend.amount, 0),
    };
    this.options.logger.info(
      {
        count: spends.length,
        totalAmount: result.totalAmount,
        paidBy: query.paidBy,
        category: query.category,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      },
      "Read Notion founder spend log",
    );
    return result;
  }
}
