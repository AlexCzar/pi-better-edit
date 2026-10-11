/**
 * #87c — the stamp-gated open: a healthy, stamp-matching open performs NO WRITE TRANSACTION AT ALL.
 *
 * WHY this file exists: the open chain used to sweep the store's generation state on every open, at
 * TWO call sites (`buildStore`'s `ensureSnapshotTables` and the snapshot-store open hook's re-entrant
 * `ensureSnapshotSchema`), and to re-write `meta('version')` on every open as well. All three are
 * writers, so a healthy open serialized against every other process on the shared store. The tests
 * below pin the replacement: a two-part stamp (the DB header's `PRAGMA user_version` for the schema
 * half, a `meta` row for the anchor-generation half) decides whether the sweep and the version upsert
 * run, and the whole fast path is proved lock-free by opening while a RIVAL HOLDS THE WRITE LOCK —
 * which no write statement can survive.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  hashStorePath,
  loadHashStore,
  shutdownHashStore,
  type HashStore,
} from "../../src/hash-store";
import { HASH_STORE_VERSION, SERVED_PRUNE_INTERVAL_MS, SERVED_TTL_MS } from "../../src/constants";
import { ANCHOR_GENERATION, CANON_VERSION, contentOnlyHashes } from "../../src/hashline";
import { splitLines } from "../../src/utils";
import { initHasher } from "../../src/hashline/hasher";
import { snapshotHashFor, upsertSnapshot } from "../../src/snapshot-store";
import { getWritableTempRoot } from "../support/fixtures";

/** The `meta` key holding the generation half of the open stamp. */
const STAMP_KEY = "store_stamp";
/** The `meta` key holding the last-run instant of the periodic served-mirror prune. */
const PRUNE_RUN_KEY = "served_prune_at";
/**
 * The stamp's documented format — `<format>:<store schema>:<canon>:<anchor generation>:<hooks>` — as a
 * shape, because the last field is the open-hook count: a build constant the test cannot import (the
 * registry is module-private and its count is only observable through the stamp it produces).
 */
const STAMP_SHAPE = new RegExp(
  `^1:${HASH_STORE_VERSION}:${CANON_VERSION}:${ANCHOR_GENERATION}:\\d+$`,
);

/**
 * Assert the store on disk carries a CURRENT stamp, and return its value so a test can compare it
 * against what a later open produces (the value must be a build constant, not a per-open value).
 */
function expectCurrentStamp(): string {
  const view = readStamp();
  expect(view.userVersion).toBe(HASH_STORE_VERSION);
  expect(view.version).toBe(String(HASH_STORE_VERSION));
  expect(view.stamp).toMatch(STAMP_SHAPE);
  return view.stamp as string;
}

beforeAll(async () => {
  await initHasher();
});

/** A store dir of this file's own, published under the env var `configDir()` reads verbatim. */
async function withStoreDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), "pi-stamp-"));
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", dir);
  try {
    await run(dir);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

interface StampView {
  userVersion: number;
  version: string | undefined;
  stamp: string | undefined;
}

/**
 * Read the stamp off the FILE, through a connection of its own — never through the open path. It
 * reads the store of the current config dir, which `withStoreDir` pins for the test.
 */
function readStamp(): StampView {
  const db = new DatabaseSync(hashStorePath());
  try {
    const header = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const rows = db
      .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
      .all("version", STAMP_KEY) as unknown as { key: string; value: string }[];
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    return {
      userVersion: header.user_version,
      version: byKey.get("version"),
      stamp: byKey.get(STAMP_KEY),
    };
  } finally {
    db.close();
  }
}

interface StatementTrace {
  beginImmediate: number;
  sweepDeletes: number;
  /** Every `exec` the open issued that would need the write lock. */
  writes: string[];
  /** Every `exec` the open issued, in order — the DDL trace of the two schema-ensure sites. */
  execs: string[];
}

/**
 * How many times the open ran the schema ensure of the snapshot tables. The sweep has TWO call sites
 * and both funnel through `ensureSnapshotTables`, so this is what proves the gate covered BOTH of them
 * rather than one of them being skipped by never being reached.
 */
function schemaEnsureSites(trace: StatementTrace): number {
  return trace.execs.filter((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS file_snapshots"))
    .length;
}

/**
 * Record every statement any connection issues, so a test can count the write-lock takers an open
 * runs. `exec`-level only: statements run through a prepared handle are covered by the rival-lock
 * test instead, because no write statement can succeed while that lock is held.
 */
function startTrace(): { stop: () => StatementTrace } {
  const proto = DatabaseSync.prototype as unknown as {
    exec: (sql: string) => unknown;
  };
  const originalExec = proto.exec;
  let beginImmediate = 0;
  let sweepDeletes = 0;
  const writes: string[] = [];
  const execs: string[] = [];
  proto.exec = function (sql: string) {
    const flat = sql.replace(/\s+/g, " ").trim();
    execs.push(flat);
    if (/^BEGIN IMMEDIATE/i.test(flat)) beginImmediate += 1;
    if (/^DELETE FROM (served_leases|file_snapshots|line_lineage)\b/i.test(flat)) sweepDeletes += 1;
    if (/^(BEGIN IMMEDIATE|COMMIT|DELETE|INSERT|UPDATE|ALTER TABLE|DROP TABLE)/i.test(flat)) {
      writes.push(flat.slice(0, 80));
    }
    return originalExec.call(this, sql);
  };
  return {
    stop: () => {
      proto.exec = originalExec;
      return { beginImmediate, sweepDeletes, writes, execs };
    },
  };
}

/** Hold the store's write lock from a rival connection and return its release function. */
function holdWriteLock(): () => void {
  const holder = new DatabaseSync(hashStorePath(), { timeout: 0 });
  holder.exec("BEGIN IMMEDIATE");
  // WHY: make the transaction a real one — a write lock is what the open must not need, and an
  // WHY: empty transaction would let SQLite collapse it.
  holder.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("rival", "1");
  return () => {
    try {
      holder.exec("ROLLBACK");
    } finally {
      holder.close();
    }
  };
}

/** A current-generation snapshot plus one lineage row, the shape a real read materializes. */
function plantSnapshot(store: HashStore, path: string, content: string): void {
  upsertSnapshot(store, {
    path,
    snapshotHash: snapshotHashFor(content),
    lineCount: splitLines(content).length,
    hashes: contentOnlyHashes(content),
    content,
  });
}

/** A snapshot row of another generation: exactly what the sweep exists to remove. */
function plantForeignGenerationRow(store: HashStore, path: string): void {
  const row = store.db
    .prepare(
      "INSERT INTO file_snapshots (path, snapshot_hash, line_count, created_at, committed, anchor_generation) " +
        "VALUES (?,?,?,?,1,?) RETURNING snapshot_id",
    )
    .get(path, `${CANON_VERSION}:999:foreign`, 3, Date.now(), 999) as { snapshot_id: number };
  store.db
    .prepare(
      "INSERT INTO line_lineage (snapshot_id, line_number, line_id, canon_hash, anchor) VALUES (?,?,?,?,?)",
    )
    .run(row.snapshot_id, 0, 987654, "deadbeefdeadbeef", "zzz1");
}

function countRows(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

describe("stamp-gated open (#87c)", () => {
  it("takes no write lock: a fast-path open succeeds while a rival holds BEGIN IMMEDIATE", async () => {
    // WHY: THE DISCRIMINATOR. The base build's open reaches the sweep's `BEGIN IMMEDIATE`, blocks on
    // WHY: the rival's write lock for its whole retry budget and throws `errcode 5` — so SUCCEEDING
    // WHY: here is a complete proof that the open took no write lock at all: SQLite cannot write
    // WHY: without it, and every write attempt would have thrown busy instead.
    await withStoreDir(async (dir) => {
      const store = await loadHashStore();
      plantSnapshot(store, join(dir, "healthy.ts"), "aaa\nbbb\nccc\n");
      expectCurrentStamp();
      shutdownHashStore();

      const release = holdWriteLock();
      const trace = startTrace();
      let opened = false;
      const started = performance.now();
      try {
        await loadHashStore();
        opened = true;
      } finally {
        const measured = performance.now() - started;
        const recorded = trace.stop();
        release();
        // WHY: the no-write proof, localized: the open issued no `BEGIN IMMEDIATE` and no sweep
        // WHY: delete. The bound is not a performance claim — it separates "completed the open" from
        // WHY: "sat in the contention budget", which the base build's failure costs.
        expect(recorded.beginImmediate).toBe(0);
        expect(recorded.sweepDeletes).toBe(0);
        expect(recorded.writes).toEqual([]);
        expect(measured).toBeLessThan(2000);
      }
      expect(opened).toBe(true);
    });
  });

  it("sweeps at both call sites on a fresh store, stamps it, then takes the fast path", async () => {
    await withStoreDir(async () => {
      const first = startTrace();
      await loadHashStore();
      const firstTrace = first.stop();
      // WHY: ONE sweep on a fresh store — the slow path runs once per open, not once per call site:
      // WHY: `buildStore`'s site sweeps and `buildStore` then stamps, so the hook's re-entrant ensure
      // WHY: finds a matching stamp and stops. The 2 deletes are the two that site can run: at that
      // WHY: point `served_leases` does not exist yet, so its two lease deletes are skipped
      // WHY: (`hasLeases`) — they are vacuous on a fresh store, which has no leases to drop.
      expect(firstTrace.beginImmediate).toBe(1);
      expect(firstTrace.sweepDeletes).toBe(2);
      // WHY: and BOTH call sites still ran their schema ensure — the gate is what skipped the second
      // WHY: sweep, not a missing second call.
      expect(schemaEnsureSites(firstTrace)).toBe(2);
      expectCurrentStamp();

      shutdownHashStore();
      const second = startTrace();
      await loadHashStore();
      const secondTrace = second.stop();
      // WHY: the fast path takes NO write lock and runs NO sweep at EITHER site: nothing of the sort
      // WHY: is issued, and the version upsert is skipped with them.
      expect(secondTrace.beginImmediate).toBe(0);
      expect(secondTrace.sweepDeletes).toBe(0);
      expect(schemaEnsureSites(secondTrace)).toBe(2);
      expect(secondTrace.writes).toEqual([]);
      expectCurrentStamp();
    });
  });

  it("a mismatch in EITHER stamp half runs the slow path and rewrites both halves", async () => {
    for (const poison of [
      {
        half: "the schema half",
        apply: (db: DatabaseSync) => db.exec("PRAGMA user_version = 0"),
        mismatched: { userVersion: 0 },
      },
      {
        half: "the generation half",
        apply: (db: DatabaseSync) =>
          db.exec(`UPDATE meta SET value = '2:1' WHERE key = '${STAMP_KEY}'`),
        mismatched: { stamp: "2:1" },
      },
    ] as const) {
      await withStoreDir(async (dir) => {
        const store = await loadHashStore();
        plantSnapshot(store, join(dir, "healthy.ts"), "aaa\nbbb\nccc\n");
        plantForeignGenerationRow(store, join(dir, "poisoned.ts"));
        expectCurrentStamp();
        poison.apply(store.db);
        expect(readStamp()).toMatchObject(poison.mismatched);
        shutdownHashStore();

        const trace = startTrace();
        const reopened = await loadHashStore();
        const recorded = trace.stop();
        // WHY: the slow path runs again — ONCE, at `buildStore`'s site: the stamp it writes at the end
        // WHY: of the build is what makes the hook's second ensure a no-op. All four sweep deletes run
        // WHY: there, because `served_leases` exists by then.
        expect(recorded.beginImmediate).toBe(1);
        expect(recorded.sweepDeletes).toBe(4);
        expect(schemaEnsureSites(recorded)).toBe(2);
        expect(
          countRows(
            reopened.db,
            "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
            ANCHOR_GENERATION,
          ),
        ).toBe(0);
        expect(
          countRows(
            reopened.db,
            "SELECT COUNT(*) AS n FROM line_lineage WHERE snapshot_id NOT IN (SELECT snapshot_id FROM file_snapshots)",
          ),
        ).toBe(0);
        expectCurrentStamp();
      });
    }
  });

  it("folds the open-hook count into the stamp, so an ADDED hook invalidates it", async () => {
    // WHY: the registry is built by module top-level pushes, so the count is a function of the BUILD.
    // WHY: This rewrites the count the way a build registering one MORE hook would leave it: the next
    // WHY: open must take the slow path — that new hook's work is not certified by the old stamp — and
    // WHY: then re-stamp its own count. LIMITATION: a swap (one hook out, one in) keeps the count, which
    // WHY: is why `HASH_STORE_VERSION`'s bump convention still governs semantic changes.
    await withStoreDir(async () => {
      const store = await loadHashStore();
      plantForeignGenerationRow(store, "/poisoned.ts");
      const count = Number((readStamp().stamp as string).split(":")[4]);
      expect(Number.isInteger(count)).toBe(true);
      store.db.exec(
        `UPDATE meta SET value = '1:${HASH_STORE_VERSION}:${CANON_VERSION}:${ANCHOR_GENERATION}:${count + 1}' WHERE key = '${STAMP_KEY}'`,
      );
      shutdownHashStore();

      const trace = startTrace();
      const reopened = await loadHashStore();
      const recorded = trace.stop();
      expect(recorded.beginImmediate).toBe(1);
      expect(
        countRows(
          reopened.db,
          "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
          ANCHOR_GENERATION,
        ),
      ).toBe(0);
      expect(expectCurrentStamp()).toBe(
        `1:${HASH_STORE_VERSION}:${CANON_VERSION}:${ANCHOR_GENERATION}:${count}`,
      );
    });
  });

  it("folds the stamp's FORMAT version in, so changing the field list invalidates old stamps", async () => {
    // WHY: the leading field exists so a future shape change invalidates every stamp written by the old
    // WHY: shape BY CONSTRUCTION. This is that claim, exercised: an unknown format takes the slow path.
    await withStoreDir(async () => {
      const store = await loadHashStore();
      plantForeignGenerationRow(store, "/poisoned.ts");
      const value = readStamp().stamp as string;
      store.db.exec(
        `UPDATE meta SET value = '0:${value.split(":").slice(1).join(":")}' WHERE key = '${STAMP_KEY}'`,
      );
      shutdownHashStore();

      const trace = startTrace();
      const reopened = await loadHashStore();
      const recorded = trace.stop();
      expect(recorded.beginImmediate).toBe(1);
      expect(
        countRows(
          reopened.db,
          "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
          ANCHOR_GENERATION,
        ),
      ).toBe(0);
      expect(expectCurrentStamp()).toBe(value);
    });
  });

  it("a stale or future HASH_STORE_VERSION takes the slow path and is rewritten", async () => {
    // WHY: the schema half of the stamp IS `HASH_STORE_VERSION`, so any change to an owner's
    // WHY: schema-ensure or gated work that bumps it invalidates every stamp on disk. Both directions
    // WHY: are checked: a store older than this build and one written by a NEWER build that this one
    // WHY: must not trust.
    for (const version of [HASH_STORE_VERSION - 1, HASH_STORE_VERSION + 1]) {
      await withStoreDir(async () => {
        const store = await loadHashStore();
        plantForeignGenerationRow(store, "/poisoned.ts");
        store.db.exec(`PRAGMA user_version = ${version}`);
        shutdownHashStore();

        const trace = startTrace();
        const reopened = await loadHashStore();
        const recorded = trace.stop();
        expect(recorded.beginImmediate).toBe(1);
        expect(
          countRows(
            reopened.db,
            "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
            ANCHOR_GENERATION,
          ),
        ).toBe(0);
        expect(expectCurrentStamp()).toMatch(STAMP_SHAPE);
      });
    }
  });

  it("a failing sweep leaves the stamp unset, and the restored open stamps it", async () => {
    // WHY: the stamp is the store's record that the WHOLE slow path — DDL, migrations and sweep —
    // WHY: completed. Stamping before (or during) the sweep would make a failed sweep permanent, so
    // WHY: this is the RED-proof test for that ordering: force the sweep to throw and the stamp must
    // WHY: still be absent; restore it and the next open stamps.
    await withStoreDir(async () => {
      const proto = DatabaseSync.prototype as unknown as { exec: (sql: string) => unknown };
      const originalExec = proto.exec;
      proto.exec = function (sql: string) {
        if (/DELETE FROM file_snapshots/i.test(sql)) throw new Error("injected mid-sweep failure");
        return originalExec.call(this, sql);
      };
      try {
        await expect(loadHashStore()).rejects.toThrow(/injected mid-sweep failure/);
      } finally {
        proto.exec = originalExec;
      }
      expect(readStamp()).toMatchObject({
        userVersion: 0,
        version: undefined,
        stamp: undefined,
      });

      await loadHashStore();
      expectCurrentStamp();
    });
  });

  it("pins the version row and the header to the store version", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      // WHY: `meta('version')` keeps its value, format and semantics — the stamp is a SECOND row.
      expect(store.db.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({
        value: String(HASH_STORE_VERSION),
      });
      expect(store.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HASH_STORE_VERSION,
      });
      shutdownHashStore();
      const reopened = await loadHashStore();
      expect(reopened.db.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({
        value: String(HASH_STORE_VERSION),
      });
      expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: HASH_STORE_VERSION,
      });
      expectCurrentStamp();
    });
  });

  it("leaves planted rows alone across a stamp-matching reopen (the deliberate trade)", async () => {
    // WHY: the sweep is an upgrade/migration action now, not a per-open one: rows that a matching
    // WHY: stamp says nothing about — here a foreign-generation row planted after the sweep — are NOT
    // WHY: removed by a reopen. This is the deliberate trade (the store's provenance is unchanged, so
    // WHY: there is nothing to upgrade); the poison goes when the stamp moves.
    await withStoreDir(async (dir) => {
      const store = await loadHashStore();
      plantForeignGenerationRow(store, join(dir, "poisoned.ts"));
      shutdownHashStore();
      const fast = await loadHashStore();
      expect(
        countRows(
          fast.db,
          "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
          ANCHOR_GENERATION,
        ),
      ).toBe(1);

      fast.db.exec("PRAGMA user_version = 0");
      shutdownHashStore();
      const slow = await loadHashStore();
      expect(
        countRows(
          slow.db,
          "SELECT COUNT(*) AS n FROM file_snapshots WHERE anchor_generation != ?",
          ANCHOR_GENERATION,
        ),
      ).toBe(0);
    });
  });
});

describe("periodic served-mirror prune (#87c)", () => {
  /** Two expired mirror rows and one fresh one, the shape the TTL prune judges. */
  function plantMirrorRows(store: HashStore): { expired: string[]; fresh: string } {
    const now = Date.now();
    const insert = store.db.prepare(
      "INSERT INTO served (session_id, path, hashes, updated_at) VALUES (?,?,?,?)",
    );
    for (const id of ["old-a", "old-b"])
      insert.run(id, `/gone/${id}.ts`, "[]", now - SERVED_TTL_MS - 1);
    insert.run("live", "/kept.ts", "[]", now);
    return { expired: ["old-a", "old-b"], fresh: "live" };
  }

  function mirrorSessions(db: DatabaseSync): string[] {
    return (
      db.prepare("SELECT session_id FROM served ORDER BY session_id").all() as unknown as {
        session_id: string;
      }[]
    ).map((row) => row.session_id);
  }

  it("a due prune deletes exactly the expired rows", async () => {
    // WHY: semantics preserved — the same predicate, the same rows: the prune still issues
    // WHY: `DELETE FROM served WHERE updated_at < ?` with the cutoff `now - SERVED_TTL_MS`, and the
    // WHY: existence read that guards it asks the SAME question with the SAME parameter.
    await withStoreDir(async () => {
      const store = await loadHashStore();
      const { expired, fresh } = plantMirrorRows(store);
      expect(expired).toHaveLength(2);
      shutdownHashStore();

      const reopened = await loadHashStore();
      expect(mirrorSessions(reopened.db)).toEqual([fresh]);
      // WHY: the run is recorded only when it actually ran, so the next open does not repeat it.
      const recorded = reopened.db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(PRUNE_RUN_KEY) as { value: string } | undefined;
      expect(recorded).toBeDefined();
    });
  });

  it("runs only when due: a backdated run stamp fires, a fresh one does not", async () => {
    await withStoreDir(async () => {
      const store = await loadHashStore();
      plantMirrorRows(store);
      // WHY: a fresh run stamp is the "already ran" state — the item must stay down.
      store.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(PRUNE_RUN_KEY, String(Date.now()));
      shutdownHashStore();
      const notDue = await loadHashStore();
      expect(mirrorSessions(notDue.db)).toEqual(["live", "old-a", "old-b"]);
      expect(
        countRows(
          notDue.db,
          "SELECT COUNT(*) AS n FROM served WHERE updated_at < ?",
          Date.now() - SERVED_TTL_MS,
        ),
      ).toBe(2);

      // WHY: backdate the run stamp past the interval and the item is due again.
      notDue.db
        .prepare("UPDATE meta SET value = ? WHERE key = ?")
        .run(String(Date.now() - SERVED_PRUNE_INTERVAL_MS - 1), PRUNE_RUN_KEY);
      shutdownHashStore();
      const due = await loadHashStore();
      expect(mirrorSessions(due.db)).toEqual(["live"]);
    });
  });

  it("does not write the run stamp when there is nothing to prune", async () => {
    // WHY: the timestamp write is itself a write-lock taker, so it is owed only to a run that
    // WHY: deleted something — otherwise a due-but-empty prune would keep the fast path lock-free and
    // WHY: yet write.
    await withStoreDir(async () => {
      await loadHashStore();
      shutdownHashStore();
      const reopened = await loadHashStore();
      expect(
        reopened.db.prepare("SELECT value FROM meta WHERE key = ?").get(PRUNE_RUN_KEY),
      ).toBeUndefined();
    });
  });
});
