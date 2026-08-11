import { describe, expect, it, vi } from "vitest";
import { notionEventNotification } from "../src/notion-webhook.js";

const task = {
  id: "page-1",
  url: "https://notion.so/page-1",
  title: "Ship launch",
  status: "In progress",
  dueAt: "2026-08-12",
  assignees: ["Tanvi"],
  priority: "High",
  taskTypes: ["Marketing"],
};

describe("Notion webhook notifications", () => {
  it("formats task property updates", async () => {
    const notion = { getTaskById: vi.fn().mockResolvedValue(task) };
    await expect(
      notionEventNotification(
        {
          id: "event-1",
          type: "page.properties_updated",
          authors: [{ id: "person-1", type: "person" }],
          entity: { id: "page-1", type: "page" },
        },
        notion as never,
        false,
      ),
    ).resolves.toContain("*Ship launch* was updated");
  });

  it("loads and formats newly created comments", async () => {
    const notion = {
      getTaskById: vi.fn().mockResolvedValue(task),
      getTaskComment: vi.fn().mockResolvedValue({
        id: "comment-1",
        author: "Sagnik",
        createdAt: "2026-08-11T10:00:00.000Z",
        text: "Needs a stronger launch list.",
      }),
    };
    await expect(
      notionEventNotification(
        {
          id: "event-2",
          type: "comment.created",
          authors: [{ id: "person-1", type: "person" }],
          entity: { id: "comment-1", type: "comment" },
          data: { page_id: "page-1" },
        },
        notion as never,
        false,
      ),
    ).resolves.toContain("Sagnik commented on *Ship launch*");
  });

  it("suppresses bot-authored events by default", async () => {
    const notion = { getTaskById: vi.fn() };
    await expect(
      notionEventNotification(
        {
          id: "event-3",
          type: "page.content_updated",
          authors: [{ id: "bot-1", type: "bot" }],
          entity: { id: "page-1", type: "page" },
        },
        notion as never,
        false,
      ),
    ).resolves.toBeNull();
    expect(notion.getTaskById).not.toHaveBeenCalled();
  });
});
