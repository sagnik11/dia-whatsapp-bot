import { describe, expect, it, vi } from "vitest";
import { NotionSpendService } from "../src/notion-spend.js";

function service() {
  return new NotionSpendService({
    apiKey: "test-key",
    dataSourceId: "spend-source",
    payerMap: { tanvi: "user-tanvi", sagnik: "user-sagnik" },
    logger: { info: vi.fn(), warn: vi.fn() } as never,
  });
}

const spend = {
  spend: "Chai",
  amount: 100,
  date: "2026-08-12",
  paidBy: "Tanvi",
  category: "Meals" as const,
  paymentMethod: "UPI" as const,
  vendor: "Chai stall",
  notes: null,
  reimbursable: false,
};

describe("NotionSpendService", () => {
  it("creates a schema-correct expense with a retry-safe reference", async () => {
    const query = vi.fn().mockResolvedValue({ results: [], has_more: false });
    const create = vi.fn().mockResolvedValue({
      object: "page",
      id: "spend-page",
      url: "https://notion.so/spend-page",
    });
    const notionSpend = service();
    Object.assign(notionSpend as unknown as { client: unknown }, {
      client: { dataSources: { query }, pages: { create } },
    });

    const result = await notionSpend.addSpends([spend], {
      messageId: "whatsapp-message-1",
      groupName: "Autter",
      requestedBy: "Sagnik",
    });

    expect(result).toMatchObject({
      paidBy: "Tanvi",
      createdCount: 1,
      duplicateCount: 0,
      failedCount: 0,
      createdAmount: 100,
    });
    expect(query).toHaveBeenCalledWith({
      data_source_id: "spend-source",
      filter: {
        property: "Notes",
        rich_text: { contains: expect.stringMatching(/^\[Patch ref: [a-f0-9]{24}\]$/) },
      },
      page_size: 1,
    });
    expect(create).toHaveBeenCalledWith({
      parent: { type: "data_source_id", data_source_id: "spend-source" },
      properties: expect.objectContaining({
        Spend: {
          type: "title",
          title: [{ type: "text", text: { content: "Chai" } }],
        },
        Amount: { type: "number", number: 100 },
        Category: { type: "select", select: { name: "Meals" } },
        Date: { type: "date", date: { start: "2026-08-12" } },
        "Paid by": { type: "people", people: [{ id: "user-tanvi" }] },
        "Payment method": { type: "select", select: { name: "UPI" } },
        Reimbursable: { type: "checkbox", checkbox: false },
      }),
    });
  });

  it("skips an entry already written from the same WhatsApp message", async () => {
    const query = vi.fn().mockResolvedValue({
      results: [
        {
          object: "page",
          id: "existing-page",
          url: "https://notion.so/existing-page",
          properties: {},
        },
      ],
      has_more: false,
    });
    const create = vi.fn();
    const notionSpend = service();
    Object.assign(notionSpend as unknown as { client: unknown }, {
      client: { dataSources: { query }, pages: { create } },
    });

    const result = await notionSpend.addSpends([spend], {
      messageId: "same-message",
      groupName: "Autter",
      requestedBy: "Sagnik",
    });

    expect(result.duplicateCount).toBe(1);
    expect(result.createdCount).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("reads filtered spend rows and totals them", async () => {
    const query = vi.fn().mockResolvedValue({
      results: [
        {
          object: "page",
          id: "page-1",
          url: "https://notion.so/page-1",
          properties: {
            Spend: { type: "title", title: [{ plain_text: "Petrol" }] },
            Amount: { type: "number", number: 333 },
            Date: { type: "date", date: { start: "2026-08-13" } },
            "Paid by": {
              type: "people",
              people: [{ id: "user-tanvi", name: "Tanvi Bhole" }],
            },
            Category: { type: "select", select: { name: "Travel" } },
            "Payment method": { type: "select", select: { name: "UPI" } },
            Vendor: { type: "rich_text", rich_text: [] },
            Notes: { type: "rich_text", rich_text: [] },
            Reimbursable: { type: "checkbox", checkbox: false },
          },
        },
      ],
      has_more: false,
    });
    const notionSpend = service();
    Object.assign(notionSpend as unknown as { client: unknown }, {
      client: { dataSources: { query } },
    });

    const result = await notionSpend.listSpends({
      paidBy: "Tanvi",
      category: "Travel",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      limit: 20,
    });

    expect(result.totalAmount).toBe(333);
    expect(result.spends[0]).toMatchObject({
      spend: "Petrol",
      amount: 333,
      paidBy: ["Tanvi Bhole"],
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        data_source_id: "spend-source",
        filter: { and: expect.arrayContaining([
          { property: "Paid by", people: { contains: "user-tanvi" } },
          { property: "Category", select: { equals: "Travel" } },
        ]) },
      }),
    );
  });
});
