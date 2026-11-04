/**
 * The go-ahead guard: deterministic code (not a prompt) that decides whether a
 * founder's own triggered message authorizes sending an email (E<id>) or
 * booking a calendar proposal (EV<id>). Model arguments, quoted messages, tool
 * results and text inside quotation marks never count.
 */

export type OutboundKind = "email" | "calendar";

export const REF_PREFIX: Readonly<Record<OutboundKind, string>> = { email: "E", calendar: "EV" };

const VERB: Readonly<Record<OutboundKind, string>> = { email: "send", calendar: "book" };

/** Parses "E12", "e12", "#12" or 12 into an id for the kind; null when it is not one. */
export function parseOutboundRef(value: unknown, kind: OutboundKind): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const prefix = REF_PREFIX[kind];
  const match = new RegExp(`^\\s*(?:${prefix}|#)?\\s*(\\d{1,9})\\s*$`, "i").exec(value);
  const id = match ? Number(match[1]) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Removes text the founder did not write as their own instruction: lines
 * starting with ">" and anything inside double, curly or backtick quotes, or
 * inside single quotes that open and close at word boundaries.
 */
export function stripQuotedText(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/"[^"]*"/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/‘[^’]*’/g, " ")
    .replace(/«[^»]*»/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/(^|[\s(])'[^'\n]*'(?=$|[\s).,!?;:])/g, "$1 ");
}

/** Refs of one kind named in a text, e.g. E3 and E12 (EV3 is never read as E3). */
export function namedRefs(text: string, kind: OutboundKind): Set<number> {
  const prefix = REF_PREFIX[kind];
  const ids = new Set<number>();
  for (const match of text.matchAll(new RegExp(`\\b${prefix}(\\d{1,9})\\b`, "gi"))) {
    ids.add(Number(match[1]));
  }
  return ids;
}

/** Anywhere before the verb in the same sentence, these void the instruction. */
const NEGATION =
  /\b(?:don'?t|do not|dont|doesn'?t|not|never|no|nobody|hold(?: off)?|wait|until|unless|before|without|cancel|stop)\b|n't\b/i;
/** Right after the instruction, these defer or redirect it ("send it to me first", "book it for Friday instead"). */
const DEFERRAL =
  /^\s*,?\s*(?:to (?:me|us|myself|tanvi|sagnik)\b|next\b|after\b|once\b|when\b|if\b|unless\b|(?:for|on) (?:review|approval|next|mon|tue|wed|thu|fri|sat|sun)|at \d)|\b(?:instead|first|later|tomorrow|tonight)\b/i;
/** A question counts only as a polite request ("can you send E12?"), never "should I send it?". */
const POLITE_REQUEST = /^\s*(?:(?:hey|ok|okay|so|patch|@\S+)[\s,]+)*(?:(?:can|could|will|would) (?:you|u)\b|please\b)/i;

interface Instruction {
  /** Refs the instruction names directly ("send E12"); empty for "send it". */
  refs: Set<number>;
}

/** Explicit go-ahead instructions in the founder's own words, after quotes are removed. */
export function goAheadInstructions(body: string, kind: OutboundKind): Instruction[] {
  const verb = VERB[kind];
  const prefix = REF_PREFIX[kind];
  const ref = `${prefix}\\d{1,9}`;
  const refList = `${ref}(?:\\s*(?:,|&|and)\\s*${ref})*`;
  const noun = kind === "email" ? "(?:e-?mail|mail|draft|reply|message)" : "(?:meeting|event|invite|call|slot)";
  const pattern = new RegExp(
    `\\b(?:go ahead and ${verb}|${verb}\\s+(?:it|that|this|them|(?:the|that|this|those|these)\\s+${noun}s?|${refList}))\\b`,
    "gi",
  );
  const text = stripQuotedText(body);
  const instructions: Instruction[] = [];
  // Sentences end at . ! ? ; or a line break.
  for (const sentence of text.match(/[^.!?;\n]+[.!?;]*/g) ?? []) {
    const question = sentence.includes("?");
    if (question && !POLITE_REQUEST.test(sentence)) continue;
    for (const match of sentence.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (NEGATION.test(sentence.slice(0, match.index))) continue;
      if (DEFERRAL.test(sentence.slice(end))) continue;
      instructions.push({ refs: namedRefs(match[0], kind) });
    }
  }
  return instructions;
}

export type GoAheadDecision = { ok: true } | { ok: false; reason: string };

/**
 * Allows an outbound action only when the founder's current message (not the
 * quote, not the model) explicitly says so, and the ref is either named in that
 * message or was created during this same request.
 */
export function checkGoAhead(input: {
  kind: OutboundKind;
  id: number;
  body: string;
  createdThisRequest: ReadonlySet<number>;
}): GoAheadDecision {
  const label = `${REF_PREFIX[input.kind]}${input.id}`;
  const verb = VERB[input.kind];
  const say = `A founder must say "${verb} ${label}" in their own message.`;
  const instructions = goAheadInstructions(input.body, input.kind);
  if (instructions.length === 0) {
    return { ok: false, reason: `No explicit go-ahead to ${verb} ${label} in the founder's message. ${say}` };
  }
  if (instructions.some((instruction) => instruction.refs.has(input.id))) return { ok: true };
  const generic = instructions.some((instruction) => instruction.refs.size === 0);
  const named = namedRefs(stripQuotedText(input.body), input.kind).has(input.id);
  if (generic && (named || input.createdThisRequest.has(input.id))) return { ok: true };
  return { ok: false, reason: `The go-ahead in the founder's message does not cover ${label}. ${say}` };
}
