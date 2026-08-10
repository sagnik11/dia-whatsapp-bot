import { describe, expect, it } from "vitest";
import { isBotTriggered, removeTextTrigger } from "../src/trigger.js";

describe("isBotTriggered", () => {
  it("accepts an actual WhatsApp mention", () => {
    expect(
      isBotTriggered({
        body: "can you help?",
        mentionedIds: ["919999999999@c.us"],
        botId: "919999999999@c.us",
        textTrigger: "@dia",
      }),
    ).toBe(true);
  });

  it("accepts the configured text trigger case-insensitively", () => {
    expect(
      isBotTriggered({
        body: "@DIA, add this as a task",
        mentionedIds: [],
        botId: "919999999999@c.us",
        textTrigger: "@dia",
      }),
    ).toBe(true);
  });

  it("does not match a longer username", () => {
    expect(
      isBotTriggered({
        body: "ask @diana about it",
        mentionedIds: [],
        botId: "919999999999@c.us",
        textTrigger: "@dia",
      }),
    ).toBe(false);
  });
});

describe("removeTextTrigger", () => {
  it("removes a text trigger from the prompt", () => {
    expect(removeTextTrigger("Hey @dia, summarize this", "@dia")).toBe(
      "Hey , summarize this",
    );
  });
});
