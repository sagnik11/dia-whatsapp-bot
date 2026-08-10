import { describe, expect, it } from "vitest";
import { isAuthorizedSender } from "../src/authorization.js";

describe("isAuthorizedSender", () => {
  it("fails closed when no owner ID is configured", () => {
    expect(isAuthorizedSender(new Set(), ["919999999999@c.us"])).toBe(false);
  });

  it("matches a configured phone number against WhatsApp's serialized ID", () => {
    expect(
      isAuthorizedSender(new Set(["+919999999999"]), ["919999999999@c.us"]),
    ).toBe(true);
  });

  it("rejects every other sender", () => {
    expect(
      isAuthorizedSender(new Set(["919999999999@c.us"]), ["918888888888@c.us"]),
    ).toBe(false);
  });
});
