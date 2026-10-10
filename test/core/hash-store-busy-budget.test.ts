import { describe, expect, it, beforeAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  busyBackoffMs,
  busyBudgetMs,
  loadHashStore,
  resolveBusyBudget,
  shutdownHashStore,
  type BusyBudget,
} from "../../src/hash-store";
import { HASH_STORE_BUSY_TIMEOUT } from "../../src/constants";
import { initHasher } from "../../src/hashline/hasher";
import { getWritableTempRoot } from "../support/fixtures";
import vitestConfig from "../../vitest.config";

/**
 * The harness ceilings, READ from vitest.config.ts rather than restated, so this file follows the
 * configuration instead of drifting from it. The contention measurements below assert against them:
 * the budget is a fraction of the ceiling, so what reddens a test that measures a real held lock is
 * only a LARGE inflation: 250 -> 500 does it (6797ms measured against a 6666.67ms ceiling), while
 * 250 -> 300, 350, 400 and 450 all pass, and so does the old-shape 1000 x 4 reshape.
 */
const harnessTestTimeoutMs = vitestConfig.test?.testTimeout ?? 0;
const harnessHookTimeoutMs = vitestConfig.test?.hookTimeout ?? 0;
const harnessCeilingMs = Math.min(harnessTestTimeoutMs, harnessHookTimeoutMs) / 3;

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
 * The production contention test below spends the PRODUCTION budget with NOTHING injected — the shape
 * every production call site has — and derives its bound from `resolveBusyBudget()`. That bound moves
 * with the constants it would have to indict, so the test does NOT redden for every constants
 * regression: measured GREEN at +20%..+80% on the timeout and at the same-model 1000 x 4 reshape, red
 * at 250 -> 500 (+100%) and at BUSY_MAX_ATTEMPTS 8 -> 100 (a test-level timeout, not an assertion) —
 * while a modest increase surfaces only in the wiring literal and the arithmetic pin below.
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
        // The draw is counted, not declared: with a budgeted draw the loop sleeps once per retry, so
        // the draw count IS the retry count (attempts = draws + 1 — the last failure throws, no draw).
        let draws = 0;
        const budget: BusyBudget = {
          timeoutMs: 25,
          maxAttempts: 4,
          backoffBaseMs: 10,
          backoffCapMs: 20,
          backoffJitterMs: 0,
          random: () => {
            draws++;
            return 0;
          },
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
          attempts: draws + 1,
        };

        // The ORIGINAL busy error object, still the shape every classifier matches (errcode 5/6 or
        // /busy|locked/) — exhaustion changes the wait, not the error.
        expect(error, JSON.stringify(locked)).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        // MEASURED attempt count, not a declaration: it cannot stay 4 if the loop spends one more.
        expect(draws + 1, JSON.stringify(locked)).toBe(budget.maxAttempts);
        // The DISCRIMINATOR here is that the INJECTED budget was the one spent, and only this can hold
        // if it was: the episode measures 199-214ms (3 runs) against the production model of 4300ms, so
        // an episode that ignored the injection spends the production 4595-4811ms and fails here. The
        // former `elapsed < cap + 600` was deleted rather than re-tightened: at 750ms it discriminated
        // neither shape — the old 4 x 1000 shape passes it too (4850 < 4900).
        expect(elapsed, JSON.stringify(locked)).toBeLessThan(busyBudgetMs());
        expect(rival.isOpen).toBe(true);
      });
    });
  });

  /**
   * The production budget, NOTHING injected — the shape every production call site uses — which is what
   * makes this test refutable by the constants: a budget injected here would override every constant it
   * is meant to guard, so no injected contention test can redden for a constants regression. The bound
   * is derived from `resolveBusyBudget()` and the attempt count is measured; that bound moves with the
   * constants as well and has not fired in any measured run (250 -> 500 reads a 7334ms bound against a
   * 6797ms episode), so a constants increase is caught by the harness CEILING, not the bound —
   * measured GREEN at +20%..+80% on the timeout and red at 250 -> 500. Cost: one
   * exhausted production budget, ~5s, because a permanently held lock must exhaust it.
   */
  it("spends the production budget on a held lock, with the attempt count measured", async () => {
    await withTempHome(async (home) => {
      await withLockedStore(home, async (rival) => {
        const production = resolveBusyBudget();

        // One attempt's cost on THIS host, at the production timeout and with no retry: the model counts
        // only the internal wait per attempt, so a bound for a measured episode needs this measurement.
        const singleStarted = Date.now();
        let singleError: unknown;
        try {
          await loadHashStore({ maxAttempts: 1, backoffJitterMs: 0 });
        } catch (caught) {
          singleError = caught;
        }
        const singleAttempt = Date.now() - singleStarted;
        expect((singleError as { errcode?: number }).errcode).toBe(5);

        // MEASURED attempt count: every retry draws its jitter from `Math.random` (nothing else in the
        // store open calls it), and the last failure throws without drawing, so attempts = draws + 1.
        let draws = 0;
        const random = vi.spyOn(Math, "random").mockImplementation(() => {
          draws++;
          return 0.5;
        });
        const started = Date.now();
        let error: unknown;
        try {
          await loadHashStore();
        } catch (caught) {
          error = caught;
        }
        const elapsed = Date.now() - started;
        random.mockRestore();
        const attempts = draws + 1;

        // Derived from the production constants: the model counts one internal wait per attempt, so the
        // bound charges every attempt its MEASURED cost, and allows the one capped sleep an episode the
        // deadline ends can overshoot by. A bound derived from the constants alone moves with them, so
        // the harness ceiling below is what catches a constants increase.
        const model = busyBudgetMs();
        const sleepsMax = model - production.timeoutMs * production.maxAttempts;
        const bound =
          production.maxAttempts * singleAttempt +
          sleepsMax +
          production.backoffCapMs +
          production.backoffJitterMs;
        const measured = { attempts, elapsed, model, bound, harnessCeilingMs, singleAttempt };

        expect(error, JSON.stringify(measured)).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/busy|locked/i);
        expect((error as { errcode?: number }).errcode).toBe(5);
        expect(attempts, JSON.stringify(measured)).toBe(production.maxAttempts);
        expect(elapsed, JSON.stringify(measured)).toBeLessThan(bound);
        expect(elapsed, JSON.stringify(measured)).toBeLessThan(harnessCeilingMs);
        expect(rival.isOpen).toBe(true);
      });
    });
  }, 30_000);

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
  /** The schedule with one fixed jitter draw — the single channel `busyBackoffMs` reads it from. */
  const draw = (value: number): BusyBudget => ({ ...schedule, random: () => value });

  it("grows exponentially from the base up to the hard cap", () => {
    const waits = [0, 1, 2, 3, 4, 5].map((attempt) => busyBackoffMs(attempt, draw(0)));
    expect(waits).toEqual([50, 100, 200, 400, 400, 400]);
  });

  it("keeps every draw inside [BASE, CAP + JITTER)", () => {
    expect(busyBackoffMs(3, draw(0))).toBe(400);
    expect(busyBackoffMs(3, draw(1))).toBe(450);
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = busyBackoffMs(attempt, draw(0.999));
      expect(wait).toBeGreaterThanOrEqual(50);
      expect(wait).toBeLessThanOrEqual(450);
    }
  });

  it("differs between consecutive attempts for one fixed draw, so lockstep writers spread", () => {
    const waits = [0, 1, 2, 3, 4].map((attempt) => busyBackoffMs(attempt, draw(0.5)));
    expect(waits).toEqual([75, 125, 225, 425, 425]);
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]);
    // Below the cap no two attempts wake at the same instant — the uniform-budget defect.
    expect(new Set(waits.slice(0, 4)).size).toBe(4);
  });

  it("keeps the production budget inside the harness ceilings", () => {
    // Stated arithmetic: 8 x 250 + (50+100+200+400+400+400+400) + 7 x 50 = 4300ms.
    expect(busyBudgetMs()).toBe(4_300);
    // vitest.config.ts: testTimeout 20000ms, hookTimeout 30000ms — read from the config, not restated.
    // Even the three budgets the corrupt-store rebuild path can spend stay inside the test ceiling, so
    // contention surfaces as a content error (busy) rather than as a killed test.
    expect(busyBudgetMs() * 3).toBeLessThan(harnessTestTimeoutMs);
  });

  it("fills the unspecified budget fields from the production constants", () => {
    const overridden = busyBudgetMs({ timeoutMs: 25, maxAttempts: 4 });
    // 4 x 25 + (100 + 150 + 250): the production backoff schedule at its maximum jitter draw.
    expect(overridden).toBe(600);
  });

  it("reads the jitter from ONE channel: the budget's `random`, else Math.random", () => {
    const injected = vi.fn(() => 1);
    const mathRandom = vi.spyOn(Math, "random").mockReturnValue(0.5);
    // An injected draw wins, and is taken exactly once per backoff...
    expect(busyBackoffMs(0, { ...schedule, random: injected })).toBe(100);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(mathRandom).not.toHaveBeenCalled();
    // ...and with nothing injected the SAME channel falls through to Math.random. There is no second,
    // positional draw argument for `withBusyRetry` to disagree with, which is the defect this pins: an
    // injected draw can no longer be silently ignored in favour of the other channel (or the reverse).
    expect(busyBackoffMs(0, schedule)).toBe(75);
    expect(mathRandom).toHaveBeenCalledTimes(1);
    mathRandom.mockRestore();
  });
});
