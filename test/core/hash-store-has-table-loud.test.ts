/**
 * #105 Q1 — a failed `tableColumns` read throws at `hasTable` only.
 *
 * WHY this file exists: `tableColumns` folds "table absent" into "read failed" with one empty set,
 * and its one silent consumer is `hasTable` in `ensureSnapshotTables`, where a failed read makes
 * `hasLeases` false and the sweep skips its two lease deletes — a partial sweep reporting success.
 * These tests pin the loud side of that contract: the seam is a `DatabaseSync` stand-in whose
 * `PRAGMA table_info` read fails while every other statement succeeds, so the only failing read is
 * the one `tableColumns` performs.
 */

import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { DomainError } from "../../src/domain-errors";
import { ensureFileUndoSchema, ensureSnapshotTables } from "../../src/hash-store";

/**
 * A `DatabaseSync` stand-in whose schema read fails while every other statement succeeds: `exec`
 * records and succeeds, `prepare` throws only for the `PRAGMA table_info` read `tableColumns`
 * performs and returns empty results otherwise (so the stamp gate reads "no stamp" and proceeds).
 */
function failingSchemaReadDb(recorded: string[]): DatabaseSync {
  const readFailure = new Error("database is not open");
  return {
    exec(sql: string): void {
      recorded.push(sql);
    },
    prepare(sql: string): unknown {
      if (sql.startsWith("PRAGMA table_info")) throw readFailure;
      return {
        get(): undefined {
          return undefined;
        },
        all(): [] {
          return [];
        },
      };
    },
  } as unknown as DatabaseSync;
}

describe("hash-store hasTable on a failed tableColumns read", () => {
  it("throws instead of partial-sweeping with hasLeases false", () => {
    const recorded: string[] = [];
    const db = failingSchemaReadDb(recorded);
    try {
      ensureSnapshotTables(db);
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError<"E_UNKNOWN">).code).toBe("E_UNKNOWN");
      return;
    }
    throw new Error("expected ensureSnapshotTables to throw on a failed tableColumns read");
  });

  it("leaves the other tableColumns consumers on the empty set", () => {
    const recorded: string[] = [];
    const db = failingSchemaReadDb(recorded);
    expect(() => ensureFileUndoSchema(db)).not.toThrow();
  });
});
