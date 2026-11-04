import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlExecutor, SqlResult, SqlValue } from "../../src/cloudflare-d1.js";

/**
 * In-memory SQLite stand-in for Cloudflare D1. D1 is SQLite, so this runs the
 * task store's real SQL (RETURNING, ON CONFLICT, json_each) in tests.
 */
export function createSqliteExecutor(): SqlExecutor & {
  close(): void;
  raw: DatabaseSync;
} {
  const database = new DatabaseSync(":memory:");
  return {
    raw: database,
    async query<Row>(
      sql: string,
      params: readonly SqlValue[] = [],
    ): Promise<SqlResult<Row>> {
      const statement = database.prepare(sql);
      const values = params as SQLInputValue[];
      if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
        const rows = statement.all(...values) as Row[];
        return { results: rows, changes: rows.length, lastRowId: null };
      }
      const result = statement.run(...values);
      return {
        results: [],
        changes: Number(result.changes),
        lastRowId: Number(result.lastInsertRowid),
      };
    },
    close: () => database.close(),
  };
}
