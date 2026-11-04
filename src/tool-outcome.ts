export type ToolOutcome =
  /** Fed back to the model for another turn. */
  | { kind: "output"; payload: unknown }
  /** A deterministic confirmation shown to the founder. */
  | { kind: "final"; text: string }
  /** Ends the request immediately with this reply. */
  | { kind: "terminal"; text: string };

export function output(payload: unknown): ToolOutcome {
  return { kind: "output", payload };
}

export function final(text: string): ToolOutcome {
  return { kind: "final", text };
}

export function terminal(text: string): ToolOutcome {
  return { kind: "terminal", text };
}

/** Raised for arguments that parse but make no sense; sent back to the model to fix. */
export class ToolArgumentError extends Error {}
