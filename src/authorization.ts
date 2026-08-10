function identityForms(value: string): string[] {
  const normalized = value.trim().toLowerCase().replace(/^\+/, "");
  if (!normalized) return [];

  const separator = normalized.indexOf("@");
  if (separator === -1) {
    return [normalized, `${normalized}@c.us`];
  }

  return [normalized, normalized.slice(0, separator)];
}

export function isAuthorizedSender(
  authorizedIds: ReadonlySet<string>,
  senderIds: readonly string[],
): boolean {
  if (authorizedIds.size === 0) return false;

  const authorizedForms = new Set(
    [...authorizedIds].flatMap((id) => identityForms(id)),
  );
  return senderIds
    .flatMap((id) => identityForms(id))
    .some((id) => authorizedForms.has(id));
}
