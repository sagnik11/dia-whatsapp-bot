import { describe, expect, it } from "vitest";
import { CAPTAIN_PATCH_PERSONA } from "../src/captain-patch.js";

describe("Captain Patch founder-specific persona", () => {
  it("keeps Sagnik's tone gentle and Tanvi's rivalry playful without changing access", () => {
    expect(CAPTAIN_PATCH_PERSONA).toContain(
      "With Sagnik Ghosh, be calm, gentle, warm, patient",
    );
    expect(CAPTAIN_PATCH_PERSONA).toContain(
      "With Tanvi Bhole, play a conspicuously one-sided comic rivalry",
    );
    expect(CAPTAIN_PATCH_PERSONA).toContain(
      "Tanvi remains an equal authorized co-founder",
    );
    expect(CAPTAIN_PATCH_PERSONA).toContain(
      "Drop the rivalry for serious, sensitive",
    );
  });
});
