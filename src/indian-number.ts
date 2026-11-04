const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1e3,
  thousand: 1e3,
  l: 1e5,
  lac: 1e5,
  lacs: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  cr: 1e7,
  crs: 1e7,
  crore: 1e7,
  crores: 1e7,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
};

const CURRENCY = /₹|\brs\.?|\binr\b/i;
const NUMBER_WITH_SUFFIX = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([a-z]+)?$/;

/**
 * Read a number the way founders type it: "1.2L" → 120000, "₹2.5 Cr" →
 * 25000000, "1,20,000" → 120000, "12k" → 12000, "40%" → 40. Returns null for
 * anything else rather than guessing.
 */
export function parseIndianNumber(input: string | number): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^(?:₹|rs\.?|inr)\s*/, "")
    .replace(/\s*(?:₹|rs\.?|inr|%)$/, "")
    .replace(/(\d),(?=\d)/g, "$1")
    .trim();
  const match = NUMBER_WITH_SUFFIX.exec(cleaned);
  if (!match) return null;
  const base = Number(match[1]);
  const suffix = match[2];
  const multiplier = suffix === undefined ? 1 : MULTIPLIERS[suffix];
  if (multiplier === undefined || !Number.isFinite(base)) return null;
  // toPrecision drops float noise such as 1.2 * 1e5 = 120000.00000000001.
  return multiplier === 1 ? base : Number((base * multiplier).toPrecision(12));
}

/** A unit implied by how the value was written: "INR" for ₹/Rs, "%" for percentages. */
export function impliedUnit(input: string | number): "INR" | "%" | null {
  if (typeof input !== "string") return null;
  if (CURRENCY.test(input)) return "INR";
  return input.trim().endsWith("%") ? "%" : null;
}

export function isInr(unit: string | null): boolean {
  return Boolean(unit && /^(?:inr|₹|rs\.?|rupees?)$/i.test(unit.trim()));
}

/** ₹1,20,000 for money, 41 repos for counts, 12.5% for percentages. */
export function formatValue(value: number, unit: string | null): string {
  const number = value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  if (isInr(unit)) return `₹${number}`;
  if (!unit) return number;
  return unit === "%" ? `${number}%` : `${number} ${unit}`;
}
