/** AUTHORIZED_USER_IDS=* lets everyone in the allowed groups use Patch. */
export const EVERYONE = "*";

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
  // "*": everyone in an allowed group may use Patch (config requires ALLOWED_GROUP_IDS then).
  if (authorizedIds.has(EVERYONE)) return true;

  const authorizedForms = new Set(
    [...authorizedIds].flatMap((id) => identityForms(id)),
  );
  return senderIds
    .flatMap((id) => identityForms(id))
    .some((id) => authorizedForms.has(id));
}
