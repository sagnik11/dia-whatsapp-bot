import { describe, expect, it } from "vitest";
import {
  formatTaskConfirmation,
  isExplicitTaskRequest,
} from "../src/assistant.js";

describe("isExplicitTaskRequest", () => {
  it.each([
    "add a task to send the proposal",
    "create a high priority task for tomorrow",
    "turn the quoted message into a task",
  ])("detects an explicit task command: %s", (message) => {
    expect(isExplicitTaskRequest(message)).toBe(true);
  });

  it("does not mistake a question about tasks for a creation command", () => {
    expect(isExplicitTaskRequest("what tasks should I add next?")).toBe(false);
  });
});

describe("formatTaskConfirmation", () => {
  it("confirms the created task with its Notion URL", () => {
    expect(
      formatTaskConfirmation([
        { id: "page-id", title: "Send proposal", url: "https://notion.so/page" },
      ]),
    ).toBe("✅ Task added: Send proposal\nhttps://notion.so/page");
  });
});
