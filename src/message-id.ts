function property(record: Record<string, unknown>, name: string): string | null {
  const value = record[name];
  return typeof value === "string" && value ? value : null;
}

export function serializeMessageId(value: unknown): string {
  if (typeof value === "string" && value) return value;
  if (!value || typeof value !== "object") {
    throw new TypeError("WhatsApp message has no usable ID");
  }

  const record = value as Record<string, unknown>;
  const serialized =
    property(record, "_serialized") ??
    property(record, "$1") ??
    property(record, "serialized");
  if (serialized) return serialized;

  const id = property(record, "id");
  const remoteValue = record.remote;
  const remote =
    typeof remoteValue === "string"
      ? remoteValue
      : remoteValue && typeof remoteValue === "object"
        ? property(remoteValue as Record<string, unknown>, "_serialized") ??
          property(remoteValue as Record<string, unknown>, "$1")
        : null;
  if (id) {
    return `${record.fromMe === true ? "1" : "0"}_${remote ?? "unknown"}_${id}`;
  }

  throw new TypeError("WhatsApp message has no usable ID");
}
