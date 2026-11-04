/** A file sent after the reply text, e.g. a CSV export as a WhatsApp document. */
export interface OutgoingFile {
  fileName: string;
  mimeType: string;
  data: Buffer;
}

export type ToolOutcome =
  /** Fed back to the model for another turn. */
  | { kind: "output"; payload: unknown }
  /** A deterministic confirmation shown to the founder, optionally with files. */
  | { kind: "final"; text: string; files?: readonly OutgoingFile[] }
  /** Ends the request immediately with this reply. */
  | { kind: "terminal"; text: string };

export function output(payload: unknown): ToolOutcome {
  return { kind: "output", payload };
}

export function final(text: string, files: readonly OutgoingFile[] = []): ToolOutcome {
  return files.length > 0 ? { kind: "final", text, files } : { kind: "final", text };
}

export function terminal(text: string): ToolOutcome {
  return { kind: "terminal", text };
}

/** Raised for arguments that parse but make no sense; sent back to the model to fix. */
export class ToolArgumentError extends Error {}
