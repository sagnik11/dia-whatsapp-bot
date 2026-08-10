import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeStaleChromiumLocks } from "../src/chromium-profile.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("removeStaleChromiumLocks", () => {
  it("removes lock files and dangling lock symlinks without touching session data", () => {
    const root = mkdtempSync(join(tmpdir(), "dia-chromium-profile-"));
    temporaryDirectories.push(root);
    const profile = join(root, "session");
    mkdirSync(profile);
    writeFileSync(join(profile, "SingletonLock"), "old-container-15");
    symlinkSync("/tmp/missing-chromium-socket", join(profile, "SingletonSocket"));
    writeFileSync(join(profile, "Cookies"), "session-data");

    const removed = removeStaleChromiumLocks(profile);

    expect(removed.map((path) => path.split("/").at(-1))).toEqual([
      "SingletonLock",
      "SingletonSocket",
    ]);
    expect(() => lstat(join(profile, "Cookies"))).not.toThrow();
  });
});

function lstat(path: string): void {
  lstatSync(path);
}
