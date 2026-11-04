/** One CSV cell. null and undefined become empty fields. */
export type CsvCell = string | number | boolean | null | undefined;

export interface CsvOptions {
  /** Prefix a UTF-8 byte-order mark so Excel reads ₹ and other non-ASCII text. Default true. */
  bom?: boolean;
  /**
   * Neutralize spreadsheet formulas: text cells starting with = + - @ tab or CR
   * get a leading apostrophe, so a quoted message cannot run as a formula when
   * a founder opens the file in Excel or Sheets. Numbers are left alone. Default true.
   */
  guardFormulas?: boolean;
}

const BOM = "﻿";
const FORMULA_START = /^[=+\-@\t\r]/;

function cellText(value: CsvCell, guardFormulas: boolean): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return guardFormulas && FORMULA_START.test(value) ? `'${value}` : value;
}

/** Quote a field when RFC 4180 requires it (comma, double quote, CR or LF), doubling quotes. */
export function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialize a header row and data rows as RFC 4180 CSV: CRLF line breaks
 * (including after the last row), quoted fields where needed, and every row
 * padded or cut to the header's width.
 */
export function toCsv(
  header: readonly string[],
  rows: ReadonlyArray<readonly CsvCell[]>,
  options: CsvOptions = {},
): string {
  const guard = options.guardFormulas ?? true;
  const lines = [header, ...rows].map((row, index) =>
    header
      .map((_, column) => csvField(cellText(row[column], guard && index > 0)))
      .join(","),
  );
  return `${options.bom === false ? "" : BOM}${lines.map((line) => `${line}\r\n`).join("")}`;
}

/** The CSV as UTF-8 bytes, ready to attach as a file. */
export function toCsvBuffer(
  header: readonly string[],
  rows: ReadonlyArray<readonly CsvCell[]>,
  options: CsvOptions = {},
): Buffer {
  return Buffer.from(toCsv(header, rows, options), "utf8");
}
