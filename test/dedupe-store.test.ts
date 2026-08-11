import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DedupeStore, normalizeDedupeKey } from "../src/dedupe-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("normalizeDedupeKey", () => {
  it("preserves string message IDs", () => {
    expect(normalizeDedupeKey("true_123@g.us_ABC")).toBe("true_123@g.us_ABC");
  });

  it("serializes object IDs before they reach SQLite", () => {
    expect(normalizeDedupeKey({ $1: "true_123@g.us_ABC" })).toBe(
      '{"$1":"true_123@g.us_ABC"}',
    );
  });
});

describe("DedupeStore", () => {
  it("can claim an object-shaped ID only once", () => {
    const directory = mkdtempSync(join(tmpdir(), "dia-dedupe-"));
    temporaryDirectories.push(directory);
    const store = new DedupeStore(join(directory, "messages.sqlite"));
    const messageId = { $1: "true_123@g.us_ABC" };

    expect(store.has(messageId)).toBe(false);
    expect(store.claim(messageId)).toBe(true);
    expect(store.has(messageId)).toBe(true);
    expect(store.claim(messageId)).toBe(false);

    store.close();
  });
});
