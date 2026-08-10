import { describe, expect, it } from "vitest";
import { resolveAssigneeId } from "../src/notion.js";

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
