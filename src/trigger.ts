export interface TriggerInput {
  body: string;
  mentionedIds: readonly string[];
  botId: string;
  textTrigger: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isBotTriggered(input: TriggerInput): boolean {
  if (input.mentionedIds.includes(input.botId)) {
    return true;
  }

  const trigger = input.textTrigger.trim();
  if (!trigger) {
    return false;
  }

  const pattern = new RegExp(`(^|\\s)${escapeRegExp(trigger)}(?=\\s|[,:;.!?]|$)`, "i");
  return pattern.test(input.body);
}

export function removeTextTrigger(body: string, textTrigger: string): string {
  const trigger = textTrigger.trim();
  if (!trigger) {
    return body.trim();
  }

  const pattern = new RegExp(`(^|\\s)${escapeRegExp(trigger)}(?=\\s|[,:;.!?]|$)`, "i");
  return body.replace(pattern, " ").trim();
}
