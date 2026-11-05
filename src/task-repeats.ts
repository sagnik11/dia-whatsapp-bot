/**
 * Spots tasks that repeat an open task, or each other within one batch, so
 * Patch can ask before adding them twice. Titles are compared on their
 * meaningful words: generic verbs and filler are ignored, so "Work on user
 * feedback" and "Work on user feedback collection" match, while "Create
 * Product Hunt content" and "Execute Product Hunt launch" do not.
 */

const IGNORED = new Set([
  "a", "an", "the", "and", "or", "to", "for", "of", "on", "in", "into", "with", "at", "by", "from", "about",
  "our", "my", "your", "their", "this", "that", "it", "its", "all", "some", "more", "new", "next",
  "task", "tasks", "item", "do", "get", "make", "create", "work", "set", "add", "prepare", "update", "send",
  "finish", "complete", "start", "write", "draft", "review", "check", "follow", "up", "please",
]);

export function titleWords(title: string): Set<string> {
  return new Set(
    title
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => (word.length > 1 || /\d/.test(word)) && !IGNORED.has(word))
      .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)),
  );
}

function normalized(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when two titles very likely describe the same piece of work. */
export function isRepeat(a: string, b: string): boolean {
  if (normalized(a) === normalized(b)) return true;
  const wordsA = titleWords(a);
  const wordsB = titleWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  // "Part 3" and "Part 4", or "Q3" and "Q4", are different pieces of work.
  const numbersA = [...wordsA].filter((word) => /\d/.test(word)).sort().join(" ");
  const numbersB = [...wordsB].filter((word) => /\d/.test(word)).sort().join(" ");
  if (numbersA && numbersB && numbersA !== numbersB) return false;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  const union = wordsA.size + wordsB.size - shared;
  // One is contained in the other, or nearly all words are shared.
  return (shared >= 2 && shared === Math.min(wordsA.size, wordsB.size)) || shared / union >= 0.75;
}

export type Repeat =
  | { kind: "open"; taskId: number; title: string }
  | { kind: "batch"; title: string };

/** For each draft that repeats an open task or an earlier draft, what it repeats. */
export function findRepeats(
  drafts: ReadonlyArray<{ title: string }>,
  open: ReadonlyArray<{ id: number; title: string }>,
): Map<number, Repeat> {
  const repeats = new Map<number, Repeat>();
  drafts.forEach((draft, index) => {
    const existing = open.find((task) => isRepeat(draft.title, task.title));
    if (existing) {
      repeats.set(index, { kind: "open", taskId: existing.id, title: existing.title });
      return;
    }
    const earlier = drafts.slice(0, index).find((other, otherIndex) => !repeats.has(otherIndex) && isRepeat(draft.title, other.title));
    if (earlier) repeats.set(index, { kind: "batch", title: earlier.title });
  });
  return repeats;
}

export function formatRepeats(drafts: ReadonlyArray<{ title: string }>, repeats: ReadonlyMap<number, Repeat>): string {
  const lines = [...repeats.entries()].map(([index, repeat]) => {
    const title = drafts[index]?.title ?? "";
    return repeat.kind === "open"
      ? `• "${title}" ≈ #${repeat.taskId} ${repeat.title}`
      : `• "${title}" ≈ "${repeat.title}" earlier in this list`;
  });
  return [
    `🔁 Not added, ${repeats.size === 1 ? "this looks like a repeat" : `these ${repeats.size} look like repeats`}:`,
    ...lines,
    'Reply "add them anyway" if they are really separate tasks.',
  ].join("\n");
}
