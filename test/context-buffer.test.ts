import { describe, expect, it } from "vitest";
import { ContextBuffer } from "../src/context-buffer.js";

describe("ContextBuffer", () => {
  it("keeps only the configured number of messages", () => {
    const buffer = new ContextBuffer(2);
    buffer.add("group", { author: "A", body: "one", timestamp: 1 });
    buffer.add("group", { author: "B", body: "two", timestamp: 2 });
    buffer.add("group", { author: "C", body: "three", timestamp: 3 });

    expect(buffer.get("group").map((message) => message.body)).toEqual([
      "two",
      "three",
    ]);
  });

  it("can exclude the triggering message", () => {
    const buffer = new ContextBuffer(3);
    buffer.add("group", { author: "A", body: "context", timestamp: 1 });
    buffer.add("group", { author: "B", body: "@dia help", timestamp: 2 });

    expect(buffer.get("group", true)).toEqual([
      { author: "A", body: "context", timestamp: 1 },
    ]);
  });
});
