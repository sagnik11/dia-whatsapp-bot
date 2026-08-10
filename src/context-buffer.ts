import type { BufferedMessage } from "./types.js";

export class ContextBuffer {
  private readonly groups = new Map<string, BufferedMessage[]>();

  public constructor(private readonly limit: number) {}

  public add(groupId: string, message: BufferedMessage): void {
    if (this.limit === 0) {
      return;
    }

    const messages = this.groups.get(groupId) ?? [];
    messages.push(message);
    this.groups.set(groupId, messages.slice(-this.limit));
  }

  public get(groupId: string, excludeLatest = false): BufferedMessage[] {
    const messages = this.groups.get(groupId) ?? [];
    const selected = excludeLatest ? messages.slice(0, -1) : messages;
    return structuredClone(selected);
  }
}
