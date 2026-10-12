/**
 * #105 Q2 — the closed `(table, column, definition)` map applies every triple it owns.
 *
 * WHY this file exists: option B moved every migration definition into `MIGRATION_COLUMNS` and
 * removed the per-call-site definition argument, so a typo in the map is the one way a migration
 * can now go wrong. This test reads the applied schema back through the public seam
 * (`ensureFileUndoSchema`) and pins every column the map owns for those tables, plus idempotency.
 * The `served` and `undo` triples are applied by `buildStore` and covered by the open-path tests.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { ensureFileUndoSchema } from "../../src/hash-store";

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[];
  return rows.map((column) => column.name);
}

describe("closed DDL identifier map", () => {
  it("applies every file_undo and cut_intent triple, idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureFileUndoSchema(db);
      expect(columnNames(db, "file_undo")).toEqual(
        expect.arrayContaining(["snapshot_hash", "transaction_id", "raw_pre"]),
      );
      expect(columnNames(db, "cut_intent")).toContain("direction");
      expect(() => ensureFileUndoSchema(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
