import { describe, expect, it } from "vitest";
import { serializeMessageId } from "../src/message-id.js";

describe("serializeMessageId", () => {
  it("accepts the legacy _serialized field", () => {
    expect(serializeMessageId({ _serialized: "legacy-message-id" })).toBe(
      "legacy-message-id",
    );
  });

  it("accepts WhatsApp Web's renamed $1 field", () => {
    expect(serializeMessageId({ $1: "current-message-id" })).toBe(
      "current-message-id",
    );
  });

  it("constructs a stable ID from key components as a final fallback", () => {
    expect(
      serializeMessageId({
        fromMe: false,
        remote: { $1: "120363000000000000@g.us" },
        id: "ABC123",
      }),
    ).toBe("0_120363000000000000@g.us_ABC123");
  });
});
