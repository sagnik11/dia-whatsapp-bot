import { describe, expect, it } from "vitest";
import {
  buildTaskQueryFilter,
  resolveAssigneeId,
  taskSummaryFromPage,
} from "../src/notion.js";

const properties = {
  title: "Task name",
  status: "Status",
  dueDate: "Due date",
  assignee: "Assignee",
  priority: "Priority",
  taskType: "Task type",
};

describe("resolveAssigneeId", () => {
  const mapping = {
    sagnik: "user-1",
    "alex smith": "user-2",
  };

  it("uses the default for an omitted assignee", () => {
    expect(resolveAssigneeId(null, "default-user", mapping)).toBe("default-user");
  });

  it("uses the default for a self-reference", () => {
    expect(resolveAssigneeId("Me", "default-user", mapping)).toBe("default-user");
  });

  it("matches configured names case-insensitively", () => {
    expect(resolveAssigneeId("Alex Smith", "default-user", mapping)).toBe("user-2");
  });

  it("leaves an unknown person unassigned", () => {
    expect(resolveAssigneeId("Unknown", "default-user", mapping)).toBeUndefined();
  });
});

describe("buildTaskQueryFilter", () => {
  it("combines title, status, and due-date filters", () => {
    expect(
      buildTaskQueryFilter(
        {
          titleContains: "proposal",
          status: "Not started",
          dueFrom: "2026-08-10",
          dueTo: "2026-08-17",
          limit: 10,
        },
        properties,
      ),
    ).toEqual({
      and: [
        { property: "Task name", title: { contains: "proposal" } },
        { property: "Status", status: { equals: "Not started" } },
        { property: "Due date", date: { on_or_after: "2026-08-10" } },
        { property: "Due date", date: { on_or_before: "2026-08-17" } },
      ],
    });
  });
});

describe("taskSummaryFromPage", () => {
  it("returns only the task fields exposed to the model", () => {
    const page = {
      object: "page",
      id: "page-1",
      url: "https://notion.so/page-1",
      properties: {
        "Task name": {
          type: "title",
          title: [{ plain_text: "Send proposal" }],
        },
        Status: { type: "status", status: { name: "Not started" } },
        "Due date": { type: "date", date: { start: "2026-08-12" } },
        Assignee: {
          type: "people",
          people: [{ name: "Sagnik Ghosh" }],
        },
        Priority: { type: "select", select: { name: "High" } },
        "Task type": {
          type: "multi_select",
          multi_select: [{ name: "Tech" }],
        },
      },
    };

    expect(taskSummaryFromPage(page as never, properties)).toEqual({
      id: "page-1",
      url: "https://notion.so/page-1",
      title: "Send proposal",
      status: "Not started",
      dueAt: "2026-08-12",
      assignees: ["Sagnik Ghosh"],
      priority: "High",
      taskTypes: ["Tech"],
    });
  });
});
