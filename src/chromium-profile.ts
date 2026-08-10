import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

const CHROMIUM_LOCK_NAMES = [
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
] as const;

export function removeStaleChromiumLocks(profileDirectory: string): string[] {
  const removed: string[] = [];

  for (const name of CHROMIUM_LOCK_NAMES) {
    const path = join(profileDirectory, name);
    try {
      lstatSync(path);
      rmSync(path, { force: true });
      removed.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return removed;
}
