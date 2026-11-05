import { describe, expect, it } from "vitest";
import { CAPTAIN_PATCH_PERSONA } from "../src/captain-patch.js";

describe("Captain Patch persona", () => {
  it("is friendly to everyone, follows each person's tone, and never shows its workings", () => {
    expect(CAPTAIN_PATCH_PERSONA).toContain("Default voice: friendly, warm, clear and direct.");
    expect(CAPTAIN_PATCH_PERSONA).toContain("no favourites, no rivalries, no teasing anyone personally");
    expect(CAPTAIN_PATCH_PERSONA).toContain("Tone for this person");
    expect(CAPTAIN_PATCH_PERSONA).toContain("Never show your reasoning");
    expect(CAPTAIN_PATCH_PERSONA).not.toMatch(/very sarcastic|rivalry with|does not like Tanvi|soft spot/i);
  });
});
