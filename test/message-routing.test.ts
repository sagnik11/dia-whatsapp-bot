import { describe, expect, it } from "vitest";
import { resolveGroupId } from "../src/bot.js";

describe("resolveGroupId", () => {
  it("uses from for incoming group messages", () => {
    expect(
      resolveGroupId({
        from: "120363000000000000@g.us",
        fromMe: false,
        to: "919999999999@c.us",
      }),
    ).toBe("120363000000000000@g.us");
  });

  it("uses to for group messages sent from the linked account", () => {
    expect(
      resolveGroupId({
        from: "919999999999@c.us",
        fromMe: true,
        to: "120363000000000000@g.us",
      }),
    ).toBe("120363000000000000@g.us");
  });

  it("ignores direct messages", () => {
    expect(
      resolveGroupId({
        from: "919888888888@c.us",
        fromMe: false,
        to: "919999999999@c.us",
      }),
    ).toBeNull();
  });
});
