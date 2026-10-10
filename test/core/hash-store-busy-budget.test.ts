import { describe, expect, it, beforeAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  busyBackoffMs,
  busyBudgetMs,
  loadHashStore,
  shutdownHashStore,
  type BusyBudget,
} from "../../src/hash-store";
import { HASH_STORE_BUSY_TIMEOUT } from "../../src/constants";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";

/**
 * #87b — the hash store's contention budget.
 *
 * The ticket's original premise (a missing `PRAGMA busy_timeout`) is REFUTED and the first test
 * below is the reason: `node:sqlite`'s `timeout` constructor option *is* SQLite's busy handler, so
 * the wiring guard measures the `PRAGMA busy_timeout` readback rather than grepping for a pragma
 * spelling. What is held here is the reframed defect — an implicit, oversized, UNIFORM budget (a 1s
 * blocked silence per attempt, four attempts, one fixed delay, so every writer woke at the same
 * instants) — now explicit, bounded and decorrelated.
 *
 * These tests need a REAL second connection holding a real RESERVED lock, so they open the store
 * under a temp HOME (the shape `test/core/hash-store.test.ts` uses) and opt out of the worker-wide
 * seam with an empty `PI_BETTER_EDIT_CONFIG_DIR` (#89) so each call resolves its own fresh store.
 */

beforeAll(async () => {
  await initHasher();
});

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-busy-budget-"));
  vi.stubEnv("HOME", tmpHome);
  vi.stubEnv("XDG_CONFIG_HOME", "");
  vi.stubEnv("PI_BETTER_EDIT_CONFIG_DIR", "");
  try {
    await run(tmpHome);
  } finally {
    shutdownHashStore();
    vi.unstubAllEnvs();
    await rm(tmpHome, { recursive: true, force: true });
  }
}

function sqlitePath(home: string): string {
  return join(home, ".config", "pi-better-edit", "hash-store.sqlite");
}

/**
 * Build the store, drop the cached handle, then take the write lock on a second connection. The
 * rival is opened with `timeout: 0` so it never waits on anything itself: it owns the lock until
 * this process COMMITs it, which is what makes the contention deterministic.
 */
async function withLockedStore(
  home: string,
  run: (rival: DatabaseSync) => Promise<void>,
): Promise<void> {
  shutdownHashStore();
  await loadHashStore();
  shutdownHashStore();
  const rival = new DatabaseSync(sqlitePath(home), { timeout: 0 });
  rival.exec("BEGIN IMMEDIATE");
  try {
    await run(rival);
  } finally {
    shutdownHashStore();
    rival.close();
  }
}

describe("hash store busy wiring (#87b)", () => {
  it("configures the SQLite busy handler that PRAGMA busy_timeout reads back", async () => {
    await withTempHome(async () => {
      const store = await loadHashStore();
      const row = store.db.prepare("PRAGMA busy_timeout").get() as { timeout: number };

      // MEASURED readback (node v26.8.1, #87b): the constructor option IS the busy handler, so the
      // pragma reports it back — `{ timeout: 250 }` reads 250, and NO option at all reads 0. This
      // is the observed number, not a recomputation, and it pins the constant to the measurement.
      expect(row.timeout).toBe(250);
      // The wiring guard proper: drop the `timeout` option from openDb and this reads 0, which is
      // both != the constant and not > 0, so losing the handler cannot pass silently.
      expect(row.timeout).toBe(HASH_STORE_BUSY_TIMEOUT);
      expect(row.timeout).toBeGreaterThan(0);
    });
  });

  it("spends a bounded, explicitly stated budget on a lock no attempt can outwait", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        const budget: BusyBudget = {
          timeoutMs: 25,
          maxAttempts: 4,
          backoffBaseMs: 10,
          backoffCapMs: 20,
          backoffJitterMs: 0,
          random: () => 0,
        };
        const cap = busyBudgetMs(budget);
        expect(cap).toBe(150); // 4 x 25 + (10 + 20 + 20)

        const started = Date.now();
        let error: unknown;
        try {
          await loadHashStore(budget);
        } catch (caught) {
          error = caught;
        }
        const elapsed = Date.now() - started;
        const locked = {
          message: (error as Error | undefined)?.message,
          errcode: (error as { errcode?: number } | undefined)?.errcode,
          elapsed,
          cap,
          rivalStillHolds: true,
          attempts: 4,
        };

        // The ORIGINAL busy error object, still the shape every classifier matches (errcode 5/6 or
        // /busy|locked/) — exhaustion changes the wait, not the error.
        expect(error, JSON.stringify(locked)).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        // Inside the stated cap, and never a hang. This is the DISCRIMINATING assertion: the old
        // fixed budget (1000ms x 4 + 3 x 100ms) spends ~4600ms on this same lock and fails here.
        expect(elapsed, JSON.stringify(locked)).toBeLessThan(cap + 600);
        expect(elapsed, JSON.stringify(locked)).toBeLessThan(1000);
        expect(rival.isOpen).toBe(true);
      });
    });
  });

  it("recovers through the retry loop when a rival releases past the internal wait", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        // The loop retries at most once here (the release lands on the first backoff draw), so the
        // attempt count is the evidence that the outer loop — not SQLite's own wait — did the work.
        const attempts: number[] = [];
        const budget: BusyBudget = {
          timeoutMs: 25,
          maxAttempts: 40,
          backoffBaseMs: 10,
          backoffCapMs: 40,
          backoffJitterMs: 0,
          // The injected draw doubles as the release point: the store open blocks the event loop
          // synchronously, so between two attempts is the only moment test code can run at all —
          // and an attempt blocked on a foreign RESERVED lock can never outwait 25ms of its own.
          random: () => {
            attempts.push(attempts.length);
            rival.exec("COMMIT");
            return 0;
          },
        };

        const started = Date.now();
        const store = await loadHashStore(budget);
        const elapsed = Date.now() - started;

        expect(store.db.isOpen).toBe(true);
        const measured = { attempts: attempts.length, elapsed, cap: busyBudgetMs(budget) };
        expect(attempts.length, JSON.stringify(measured)).toBe(1);
        expect(elapsed, JSON.stringify(measured)).toBeLessThan(1000);
      });
    });
  });
});

describe("busyBackoffMs (#87b)", () => {
  const schedule: BusyBudget = {
    backoffBaseMs: 50,
    backoffCapMs: 400,
    backoffJitterMs: 50,
  };

  it("grows exponentially from the base up to the hard cap", () => {
    const waits = [0, 1, 2, 3, 4, 5].map((attempt) => busyBackoffMs(attempt, () => 0, schedule));
    expect(waits).toEqual([50, 100, 200, 400, 400, 400]);
  });

  it("keeps every draw inside [BASE, CAP + JITTER)", () => {
    expect(busyBackoffMs(3, () => 0, schedule)).toBe(400);
    expect(busyBackoffMs(3, () => 1, schedule)).toBe(450);
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = busyBackoffMs(attempt, () => 0.999, schedule);
      expect(wait).toBeGreaterThanOrEqual(50);
      expect(wait).toBeLessThanOrEqual(450);
    }
  });

  it("differs between consecutive attempts for one fixed draw, so lockstep writers spread", () => {
    const fixed = () => 0.5;
    const waits = [0, 1, 2, 3, 4].map((attempt) => busyBackoffMs(attempt, fixed, schedule));
    expect(waits).toEqual([75, 125, 225, 425, 425]);
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]);
    // Below the cap no two attempts wake at the same instant — the uniform-budget defect.
    expect(new Set(waits.slice(0, 4)).size).toBe(4);
  });

  it("keeps the production budget inside the harness ceilings", () => {
    // Stated arithmetic: 8 x 250 + (50+100+200+400+400+400+400) + 7 x 50 = 4300ms.
    expect(busyBudgetMs()).toBe(4_300);
    // vitest.config.ts: testTimeout 20000ms, hookTimeout 30000ms. Even the three budgets the
    // corrupt-store rebuild path can spend stay inside the test ceiling, so contention surfaces as
    // a content error (busy) rather than as a killed test.
    expect(busyBudgetMs() * 3).toBeLessThan(20_000);
  });

  it("fills the unspecified budget fields from the production constants", () => {
    const overridden = busyBudgetMs({ timeoutMs: 25, maxAttempts: 4 });
    // 4 x 25 + (100 + 150 + 250): the production backoff schedule at its maximum jitter draw.
    expect(overridden).toBe(600);
  });
});
