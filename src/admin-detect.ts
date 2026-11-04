// Intent detection and id references for the admin and ops module.

export function isComplianceRequest(message: string): boolean {
  return (
    /\bcompliance\b|\bstatutory\b|\bfilings?\b|\b(?:our|the)\s+CA\b|\b(?:gstr-?\w*|tds\s+returns?|roc|itr)\b/i.test(message) ||
    /\bCO\d{1,9}\b/.test(message)
  );
}

export function isMetricsRequest(message: string): boolean {
  return /\b(?:metrics?|kpis?|mrr|arr|runway|burn\s+rate)\b/i.test(message);
}

export function isPipelineRequest(message: string): boolean {
  return (
    /\b(?:pipeline|deals?|prospects?|crm)\b|\bto (?:the )?(?:pilots?|leads?)\b/i.test(message) ||
    /\bP\d{1,9}\b/.test(message)
  );
}

export function isHiringRequest(message: string): boolean {
  return /\bcandidates?\b|\bhiring\b|\binterview(?:s|ing|ed)?\b|\boffer\s+letter\b/i.test(message) || /\bC\d{1,9}\b/.test(message);
}

export function isInvestorUpdateRequest(message: string): boolean {
  return /\binvestor\s+update\b|\bupdate\s+(?:for|to)\s+(?:our\s+)?investors\b/i.test(message);
}

export function isAdminRequest(message: string): boolean {
  return (
    isComplianceRequest(message) ||
    isMetricsRequest(message) ||
    isPipelineRequest(message) ||
    isHiringRequest(message) ||
    isInvestorUpdateRequest(message)
  );
}

const LIST = "((?:\\d{1,9}(?:\\s*(?:,|&|\\band\\b)\\s*)?)+)";

function collectIds(text: string, patterns: readonly RegExp[]): Set<number> {
  const ids = new Set<number>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const id of (match[1] ?? "").matchAll(/\d{1,9}/g)) ids.add(Number(id[0]));
    }
  }
  return ids;
}

/** Ids a founder named as CO3 / P2 / C4, or "compliance 3", "deal 2", "candidate 4". */
export function referencedAdminIds(text: string) {
  return {
    compliance: collectIds(text, [/\bCO(\d{1,9})\b/g, new RegExp(`\\bcompliance(?:\\s+items?)?\\s*#?${LIST}`, "gi")]),
    deals: collectIds(text, [/\bP(\d{1,9})\b/g, new RegExp(`\\bdeals?\\s*#?${LIST}`, "gi")]),
    candidates: collectIds(text, [/\bC(\d{1,9})\b/g, new RegExp(`\\bcandidates?\\s*#?${LIST}`, "gi")]),
  };
}
