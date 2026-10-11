// SAFETY: large-class — hasher module owns single wasm instance and helpers as cohesive unit; no split needed.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { rename, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { errCode } from "./utils.js";
import { initHasher } from "./hashline/hasher.js";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants.js";
import { ANCHOR_GENERATION, CANON_VERSION } from "./hashline/hash-identity.js";

function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function configBase(): string {
  if (process.platform !== "win32") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) return xdg;
  }
  // SAFETY: join of trusted homedir (or HOME env validated by OS) with fixed ".config" segment — not user-controlled traversal, base is homedir and suffix is constant.
  return join(homeBase(), ".config");
}

export function configDir(): string {
  // WHY: precedence for the app config dir is PI_BETTER_EDIT_CONFIG_DIR > XDG_CONFIG_HOME > $HOME/.config
  // WHY: — off Windows only. configBase() reads XDG_CONFIG_HOME behind a `process.platform !== "win32"`
  // WHY: guard, so on Windows this env var is the only way to relocate the store.
  // SAFETY: PI_BETTER_EDIT_CONFIG_DIR is trusted operator config, not attacker-controlled tool input, and
  // SAFETY: it is returned VERBATIM: configDir() appends nothing, sanitises nothing and creates nothing.
  // SAFETY: It IS a filesystem path, though — resolved against process.cwd() when relative, created on
  // SAFETY: first open by openStore() (mkdir(recursive: true)), and any EEXIST/EACCES/EINVAL from that
  // SAFETY: mkdir or the SQLite open surfaces raw out of the open path without naming the variable. The
  // SAFETY: contract is deliberately verbatim — trimming, validating or wrapping here is out of scope by
  // SAFETY: ticket mandate, so do not "fix" that; document it instead. An empty string counts as UNSET,
  // SAFETY: mirroring the XDG reading in configBase() above.
  const override = process.env.PI_BETTER_EDIT_CONFIG_DIR;
  if (override && override.length > 0) return override;
  // SAFETY: join of trusted configBase (homedir/.config) with fixed "pi-better-edit" — constant suffix, no traversal.
  return join(configBase(), "pi-better-edit");
}

export function hashStorePath(): string {
  // SAFETY: join of trusted configDir with fixed "hash-store.sqlite" — constant suffix, no traversal.
  return join(configDir(), "hash-store.sqlite");
}

export function legacyHashStorePath(): string {
  // SAFETY: join of trusted configDir with fixed "hash-store.json" — constant suffix, no traversal.
  return join(configDir(), "hash-store.json");
}

export function hashStoreDir(): string {
  return dirname(hashStorePath());
}

export function isCorruptionError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") {
      return errcode === 11 || errcode === 24 || errcode === 26;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /NOTADB|CORRUPT/.test(code)) return true;
  }
  return (
    error instanceof Error &&
    /corrupt|not a database|malformed|database disk image/i.test(error.message)
  );
}

function isBusyError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") return errcode === 5 || errcode === 6;
  }
  return error instanceof Error && /busy|locked/i.test(error.message);
}

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

// WHY: (#87b) the retry policy below REFRAMES the defect, which was never a missing timeout.
// WHY: `node:sqlite`'s `timeout` constructor option IS SQLite's busy handler — `PRAGMA busy_timeout`
// WHY: reports it back verbatim ({ timeout: 250 } reads 250, probe-measured: no option at all reads 0) — so no pragma was
// WHY: absent here and adding one would install a second, competing budget. The real defect was an
// WHY: IMPLICIT, OVERSIZED, UNIFORM one: every attempt could sit blocked and silent for a full
// WHY: second, there were four of them, and the gap between them was one fixed 100ms, so writers
// WHY: that started together woke together and re-collided. The replacement is EXPLICIT (these
// WHY: constants), BOUNDED (the deadline busyBudgetMs computes from them) and DECORRELATED
// WHY: (jittered exponential backoff instead of one fixed delay).
// WHY: these numbers — the model as arithmetic, attempts x internal wait + sleeps:
// WHY:   internal wait  250ms x 8 attempts                     = 2000ms
// WHY:   backoff sleeps 50+100+200+400+400+400+400 (cap 400)   = 1950ms
// WHY:   jitter         7 sleeps x <= 50ms                     =  350ms
// WHY:   ---------------------------------------------------------------
// WHY:   modelled episode (busyBudgetMs)                       = 4300ms
// WHY: 250ms rather than the previous 1000ms: the contended critical section is one short WAL write
// WHY: transaction, so a second of blocked silence DWARFED the thing being waited for, and four such
// WHY: silences made a contended open indistinguishable from a hang.
// WHY: Eight attempts at 250ms buy back the patience the old 4 x 1000 + 3 x 100 shape had — the SAME
// WHY: 4300ms model — so the two shapes cannot be told apart by aggregate duration; the tests below
// WHY: separate them by attempt count and by per-attempt stall, which the shapes DO differ in.
// WHY: the model is what the constants were chosen against, not what an attempt costs. SQLite returns
// WHY: SQLITE_BUSY once the busy timeout elapses, so ONE attempt against a permanently held lock
// WHY: spends its full 250ms internal wait plus a small constant overhead of connection-open and
// WHY: statement work. That overhead varies with the harness rather than with these constants — a store
// WHY: opened per attempt or pre-built, the way the rival takes the lock, the host — so it carries no
// WHY: figure here, and neither does anything derived from it: a millisecond band read off one harness
// WHY: is a fact about that harness, not about this code. A retry pays the overhead ONCE, not once per
// WHY: lock-taking statement, because a contended attempt blocks at its FIRST lock-taking statement and
// WHY: does no body work. The overhead is the same whatever the per-attempt wait is, so a shape's real
// WHY: cost is its attempts x (its own timeout + that overhead) plus its sleeps: four overheads on the
// WHY: old 4 x 1000 + 300 shape, eight on the 8 x 250 + 2300 one, both sitting on the same 4300ms model
// WHY: above.
// WHY: the deadline is the backstop, not the usual terminator: it is checked AFTER each attempt, so it
// WHY: can only end an episode between attempts — one capped sleep plus one already-running attempt past
// WHY: it. At these constants the COUNT is what ends an episode — a lock no attempt can outwait fails
// WHY: every attempt, and the tests below assert the count explicitly against `maxAttempts` — while the
// WHY: deadline remains the backstop that can end an episode below it. What the count then adds on top
// WHY: of the model is the arithmetic the model is already made of: the per-attempt overhead times the
// WHY: attempt count, less what the model over-charges in its jitter term, because it charges every
// WHY: backoff its MAXIMUM draw while an episode pays some fraction of one. Injected and uninjected runs
// WHY: are ONE quantity, not two: a budget injected with exactly these values resolves to the same model,
// WHY: which is why the contention test below injects nothing — an injected budget replaces every
// WHY: constant it would be guarding.
// WHY: scoped to THESE constants: an injected budget carries its own, larger model — maxAttempts 100
// WHY: models 68.7s (code-derived: 100 x 250ms plus 43.7s of capped backoff and jitter) —
// WHY: so what is bounded is the episode's own model, never 'one episode is capped at 4300ms'.
// WHY: 4300ms is 21.5% of the harness `testTimeout` (20000ms) and 14% of `hookTimeout` (30000ms), so
// WHY: contention surfaces as the busy error rather than as a killed test. The corrupt-store rebuild
// WHY: path can spend three budgets (3 x 4300 = 12.9s), but only immediately after quarantine
// WHY: replaced the file — when no rival can still hold the old inode.
const BUSY_MAX_ATTEMPTS = 8;
const BUSY_BACKOFF_BASE_MS = 50;
const BUSY_BACKOFF_CAP_MS = 400;
const BUSY_BACKOFF_JITTER_MS = 50;

/**
 * The store's contention budget: how long one attempt may wait inside SQLite (`timeoutMs`, the
 * constructor option that `PRAGMA busy_timeout` reports) and how the retry loop spaces its attempts.
 * Every field is optional — production call sites pass nothing and get the constants above, plus the
 * real clock for the deadline — so a caller that must not spend the production budget, or must pin the
 * schedule or the deadline source (a test making a branch deterministic), can say so explicitly without
 * any production call site changing.
 */
export interface BusyBudget {
  /** SQLite's own busy-handler wait per statement; 0 disables that wait. */
  timeoutMs?: number;
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /** First backoff; doubles per attempt. */
  backoffBaseMs?: number;
  /** Hard ceiling on the exponential term. */
  backoffCapMs?: number;
  /** Upper bound of the jitter draw added to every backoff. */
  backoffJitterMs?: number;
  /** The jitter draw, in [0, 1). Injectable so a test can pin the schedule. */
  random?: () => number;
  /**
   * The clock the deadline is measured against, in the same sense as `Date.now`. Injectable so a test
   * can FREEZE it — the attempt count is then the only terminator, which is the branch that asserts an
   * exact count — or jump it past the deadline, which exercises the documented backstop deterministically
   * instead of waiting for a loaded host to reach it. Nothing injected means the real clock, so every
   * production call site keeps measuring wall time exactly as it did before.
   */
  now?: () => number;
}

/**
 * `overrides` filled in field by field from the production constants above — the one place those
 * constants acquire meaning. Exported because it is the only honest source for an assertion: a test
 * derives the production timeout, attempt count and model here instead of restating 250/8/4300 as
 * literals, which would keep passing if the constants moved.
 */
export function resolveBusyBudget(overrides?: BusyBudget): Required<BusyBudget> {
  return {
    timeoutMs: overrides?.timeoutMs ?? HASH_STORE_BUSY_TIMEOUT,
    // SAFETY: DEFENSIVE, not the mechanism: the loop's own `attempt >= maxAttempts - 1` guard throws
    // SAFETY: after the FIRST failed attempt for any maxAttempts <= 1, so the single attempt is
    // SAFETY: guaranteed by the loop itself. What the floor buys is a sane RESOLVED model —
    // SAFETY: `resolveBusyBudget` maps 0 -> 1 attempt and -1 -> 1, and `busyBudgetMs` maps
    // SAFETY: 0 -> 250ms and -250 -> 250ms — so no caller reads a non-positive deadline.
    maxAttempts: Math.max(1, Math.trunc(overrides?.maxAttempts ?? BUSY_MAX_ATTEMPTS)),
    backoffBaseMs: overrides?.backoffBaseMs ?? BUSY_BACKOFF_BASE_MS,
    backoffCapMs: overrides?.backoffCapMs ?? BUSY_BACKOFF_CAP_MS,
    backoffJitterMs: overrides?.backoffJitterMs ?? BUSY_BACKOFF_JITTER_MS,
    random: overrides?.random ?? (() => Math.random()),
    // SAFETY: `Date.now` by reference (not a wrapper), so the default IS the real clock: a caller that
    // SAFETY: injects nothing gets production wall-clock behaviour, and the optional seam cannot change
    // SAFETY: what any existing call site measures.
    now: overrides?.now ?? Date.now,
  };
}

/**
 * The wait before retry `attempt` (0-based): exponential from `backoffBaseMs`, doubled per attempt
 * and capped at `backoffCapMs`, plus a draw in [0, backoffJitterMs). The jitter is the point — it is
 * what stops writers that started together from waking together again on every attempt. The draw comes
 * from `budget.random` and from NOWHERE else: one injection channel, so a caller that sets `random`
 * cannot have it silently ignored in favour of `Math.random`, and a caller that does not gets
 * `Math.random` — never a positional argument that `withBusyRetry` would have had to agree about.
 */
export function busyBackoffMs(attempt: number, overrides?: BusyBudget): number {
  const budget = resolveBusyBudget(overrides);
  const exponential = budget.backoffBaseMs * 2 ** Math.max(0, attempt);
  return Math.min(budget.backoffCapMs, exponential) + budget.random() * budget.backoffJitterMs;
}

/**
 * The modelled worst case of one contention episode: every attempt spending its full internal wait,
 * plus every backoff at its maximum jitter draw. `withBusyRetry` uses it as a wall-clock deadline, so
 * the number the constants above were chosen against is also the number the loop enforces.
 */
export function busyBudgetMs(overrides?: BusyBudget): number {
  const budget = resolveBusyBudget(overrides);
  let total = budget.timeoutMs * budget.maxAttempts;
  for (let attempt = 0; attempt < budget.maxAttempts - 1; attempt++) {
    // WHY: the model takes every backoff at the MAXIMUM jitter draw, whatever `random` would return.
    total += busyBackoffMs(attempt, { ...budget, random: () => 1 });
  }
  return total;
}

/**
 * Run `fn` under the store's contention budget. EVERY store write funnels through here — the open
 * (via `openDbWithBusyRetry`), `withStore`, and the statement-level retries in snapshot-store,
 * undo-store and the served session — so this budget and its deadline apply to all of them, not just
 * to the open. On exhaustion the ORIGINAL error is rethrown unchanged, so every caller keeps
 * classifying busy against corrupt exactly as it did before.
 * A retried open re-enters the WHOLE `buildStore` sequence from the top, because the open is not one
 * transaction: `buildStore` is many independent statement sites — the PRAGMAs, the `CREATE
 * TABLE/INDEX IF NOT EXISTS` set, the conditional DROP of the pre-session-keyed served shell, the meta
 * version INSERT, the `addColumnIfMissing` and rename helpers and the two `ensure*` helpers (one of
 * which owns the generation sweep) — every one autocommit, so partial progress survives a failed
 * attempt and the only transaction on the OPEN path is the sweep's own `BEGIN IMMEDIATE`. A retried
 * write re-enters the WHOLE caller body for the same reason, because this budget wraps `withStore`'s
 * `BEGIN IMMEDIATE ... COMMIT` too, and that transaction cannot serve the open instead: the open hooks
 * run before the store handle is published and `withStore` refuses without it, so the open path has
 * one transaction while the write path retries its whole body.
 * The ceiling on re-entry is therefore `maxAttempts` and not one attempt — 4 -> 8 (2x) on an
 * idempotent, lock-serialized path, at the SAME 4300ms TOTAL model either way: the internal waiting
 * moved with the shape, 8 x 250ms = 2000ms here against 4 x 1000ms = 4000ms there, while the model
 * that replaced it holds the TOTAL at 4300ms. That is a WASH under sustained contention, because a
 * contended attempt blocks at its FIRST lock-taking statement — one full busy timeout plus the same
 * connection and statement overhead in either shape, an overhead these constants do not model and a
 * comment cannot derive, so it carries no figure here — and does no body work; the attempts each
 * shape spends are its own `maxAttempts`, 4 there against 8 here. The INTERLEAVED case, a rival
 * taking the lock BETWEEN statements, can reach that ceiling and is BOUNDED BUT UNMEASURED.
 */
export function withBusyRetry<T>(fn: () => T, overrides?: BusyBudget): T {
  const budget = resolveBusyBudget(overrides);
  // SAFETY: a deadline, not only an attempt count — an attempt already inside SQLite cannot be
  // SAFETY: interrupted, so the count alone would let one slow attempt extend the episode without bound.
  // SAFETY: The check runs AFTER the attempt that failed, so a deadline-ended episode stops between
  // SAFETY: attempts: at most one capped sleep plus one already-running attempt past the deadline.
  // SAFETY: The clock is `budget.now` — the real clock unless a caller injects one — so production keeps
  // SAFETY: measuring wall time while a test can freeze or jump the deadline source through the same
  // SAFETY: optional budget argument. This backstop is what lets an episode end BELOW `maxAttempts`
  // SAFETY: attempts, so no caller may treat an exact count as guaranteed.
  const deadline = budget.now() + busyBudgetMs(budget);
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyError(error) || attempt >= budget.maxAttempts - 1 || budget.now() >= deadline) {
        throw error;
      }
      sleepSync(busyBackoffMs(attempt, budget));
    }
  }
}

export function getCached<T>(
  db: DatabaseSync,
  cache: WeakMap<DatabaseSync, T>,
  build: (db: DatabaseSync) => T,
): T {
  let v = cache.get(db);
  if (v) return v;
  v = build(db);
  cache.set(db, v);
  return v;
}

export interface HashStore {
  readonly db: DatabaseSync;
  readonly engine: "node:sqlite";
}

/**
 * One open of the store FILE: the connection, plus the stamp-due decision `buildStore` made for it — the
 * persisted stamp did not match, so this open built, migrated and swept the store. `openStore` owes the
 * stamp write exactly when it is true, and pays it after the hooks; see `writeStoreStamp`.
 */
interface OpenedDb {
  readonly db: DatabaseSync;
  readonly stampDue: boolean;
}

let cachedDb: { path: string; db: DatabaseSync } | null = null;
let opening: { path: string; promise: Promise<HashStore> } | null = null;
let exitHandlerRegistered = false;

/**
 * The stamp-due decision of the open that OWNS this connection right now, or `null` between opens:
 * `openStore` moves `buildStore`'s decision here for the hook phase, and the snapshot-store hook's
 * re-entrant `ensureSnapshotSchema` consults it instead of the persisted stamp. The persisted stamp
 * cannot answer for the hook phase — `openStore` writes it only after the LAST hook — so on the slow path
 * a row-based gate would sweep a SECOND time: every slow open, every upgrade, would pay two sweeps. The
 * decision is spent by the time the hooks run (the sweep's own site, `buildStore`, applies it first), so
 * a call from the hook phase only ever SKIPS the sweep. Cleared when the hook phase ends, so a caller
 * outside an open — the exported seam, a test that moves the stamp — decides from the row.
 * One slot is enough because opens are serialized: `loadHashStore` keeps one `opening` promise per path.
 */
let openStamp: { readonly db: DatabaseSync; readonly due: boolean } | null = null;

/** Whether the open that owns this connection has already settled the generation sweep. */
function sweepSettledByOpen(db: DatabaseSync): boolean {
  return openStamp !== null && openStamp.db === db;
}

export type StoreOpenHook = (db: DatabaseSync, info: { existed: boolean }) => void | Promise<void>;

const openHooks: StoreOpenHook[] = [];

export function onStoreOpen(hook: StoreOpenHook): void {
  openHooks.push(hook);
}

function openDbWithBusyRetry(storePath: string, budget?: BusyBudget): OpenedDb {
  return withBusyRetry(() => openDb(storePath, budget), budget);
}

function openDb(storePath: string, budget?: BusyBudget): OpenedDb {
  const db = new DatabaseSync(storePath, {
    // WHY: this option IS the busy handler the wiring guard reads back as `PRAGMA busy_timeout`.
    timeout: resolveBusyBudget(budget).timeoutMs,
  });
  let stampDue: boolean;
  try {
    stampDue = buildStore(db);
  } catch (error) {
    try {
      db.close();
    } catch (closeError: unknown) {
      console.error("[hash-store] failed to close DB after buildStore error:", closeError);
    }
    throw error;
  }
  return { db, stampDue };
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set<string>();
  }
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  if (!tableColumns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function renameGenerationColumn(db: DatabaseSync, table: string): void {
  const cols = tableColumns(db, table);
  if (cols.has("anchor_generation")) return;
  if (cols.has("canon_version")) {
    try {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN canon_version TO anchor_generation`);
      return;
    } catch {
      db.exec(`ALTER TABLE ${table} ADD COLUMN anchor_generation INTEGER NOT NULL DEFAULT 0`);
      db.exec(`UPDATE ${table} SET anchor_generation = canon_version`);
      // SAFETY: the RENAME fallback tolerates a store that keeps both columns — the DROP
      // SAFETY: fails on SQLite builds without DROP COLUMN support, and a both-columns store is
      // SAFETY: inert: every v7 reader/writer names `anchor_generation` only, and the leftover
      // SAFETY: `canon_version` values were already copied over by the UPDATE above, so the stale
      // SAFETY: column is never read. A concurrently open pre-rename process whose prepared
      // SAFETY: statement names `canon_version` breaks fail-closed on its next step (same failure
      // SAFETY: class as the v6 `canons` guard below) — exposure is the unreleased intermediate
      // SAFETY: build only; see ADR-0031 §4.
      try {
        db.exec(`ALTER TABLE ${table} DROP COLUMN canon_version`);
      } catch {}
      return;
    }
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN anchor_generation INTEGER NOT NULL DEFAULT 0`);
}

// WHY: (#87c) the open stamp — the store's own record that its schema, the generation its persisted
// WHY: anchors were derived under, and the BUILD that wrote it all agree with the one reading it.
// WHY: It is carried as the header field `PRAGMA user_version` (free: no query, no lock) plus one
// WHY: indexed read of `meta`. The version row is part of the gate even though it carries no new
// WHY: information, because the fast path SKIPS the upsert that maintains it: a gate that ignored the
// WHY: row could leave a deleted one unrestored for as long as the rest of the stamp matched.
// WHY: The value is a VERSIONED FORMAT and carries IDENTITY only:
// WHY:     <format>:<store schema>:<canon>:<anchor generation>:<registered open hooks>
// WHY: - the LEADING field is the format version: bump it when the field list below changes shape, so
// WHY:   every stamp written by the old shape is invalid BY CONSTRUCTION rather than by luck.
// WHY: - `HASH_STORE_VERSION` is the schema half — `constants.ts` says when it must move.
// WHY: - `CANON_VERSION` and `ANCHOR_GENERATION` are the persisted anchor set's generation.
// WHY: - the OPEN-HOOK COUNT is the build fingerprint. The registry is built by module top-level
// WHY:   pushes, so the count is a function of the BUILD: a build that registers an ADDITIONAL hook
// WHY:   mismatches every stamp an older build wrote, instead of silently suppressing the new hook's
// WHY:   work. LIMITATION, stated rather than implied: a SWAP (one hook removed, another added) keeps
// WHY:   the count, so this guards ADDITION only — a semantic change to an existing hook still needs
// WHY:   the version bump above. The count is preferred over a hash of the hook list: a hash would
// WHY:   have to be measured free on the bundled artifact to earn its place, and the count is free by
// WHY:   construction. A module imported lazily that registers a hook later costs one extra slow open:
// WHY:   the count moves, the stamp mismatches, and the next open re-stamps.
// WHY: NO TIME-VARYING STATE IS FOLDED IN. Due-ness instants — the periodic served-mirror prune's
// WHY: last-run row, the janitor's schedule — live in their OWN `meta` rows. Folding one in would
// WHY: conflate "the store's identity changed" with "maintenance is due", and a reader could not tell
// WHY: from a mismatch WHY the open took the slow path.
// WHY: BOTH halves must match, so a half-written stamp can only send the next open down the slow path,
// WHY: never past it.
//
// WHY: the traps this gate is built around, and how each is answered:
// WHY: (a) A STAMP WITH A MISSING OBJECT: the DDL above runs unconditionally, so a dropped table or
// WHY:     index is recreated on the very next open. What a matching stamp buys is narrower than
// WHY:     "everything is present" — it says the SWEEP has run for this provenance, so the sweep is all
// WHY:     it may skip. Rows the skipped sweep would have removed survive (see (c)); every reader that
// WHY:     consumes them is generation-gated and fails closed, so the exposure is latency, not safety.
// WHY: (b) TWO BUILDS SHARING ONE STORE: a build whose stamp differs — including one that writes no
// WHY:     stamp at all — mismatches, re-sweeps, and re-stamps its own view; the other build then
// WHY:     mismatches in turn. Fail-safe and merely slower: they alternate between the slow and fast
// WHY:     paths instead of either one trusting a stamp it did not write.
// WHY: (c) ROW-LEVEL POISONING: the deliberate trade, and the DURATION of the exposure. The sweep is an
// WHY:     upgrade/migration action now, not a per-open one, so a row poisoned AFTER the sweep that
// WHY:     stamped the store is not removed by a stamp-matching reopen. What this changes is WHEN foreign
// WHY:     rows can exist, never WHETHER they can:
// WHY:     - TODAY'S BOUND, the only deterministic one: the next stamp-invalidating event — a generation
// WHY:       or schema bump, an ADDITIONAL open hook, or a fresh store. Nothing else bounds it until the
// WHY:       periodic bound lands.
// WHY:     - PERIODIC BOUND: DESIGN-COMMITTED AND NOT YET IMPLEMENTED. Issue #90 records it — GC on
// WHY:       lifecycle events only, throttled to at most about once a day, never on the tool-call open
// WHY:       path, with batched deletes, `wal_checkpoint(TRUNCATE)` on close and a live-store guard. That
// WHY:       design is NOT yet in `docs/` (#90 should land it there or as an ADR before this comment can
// WHY:       cite it as a commitment rather than as an intention).
// WHY:     - TRIGGER: operator action only — a hand-edited store, or a copy taken from one. Nothing in
// WHY:       normal operation reaches it.
// WHY:     WHY THE TRADE IS SURVIVABLE: no honoring path trusts a stored row without re-deriving from the
// WHY:       bytes it is about. A lease is generation-gated AT USE TIME (`isCurrentAnchorGeneration` on
// WHY:       the lease's own 3-part `served_snapshot_hash`, `src/mutation-engine/edit-source.ts`), and its
// WHY:       resolved span must clear the MVCC contiguity gate (`verifyRebasedSpan` -> `E_STALE_RANGE`,
// WHY:       `src/hashline/served-verification.ts`), whose line identities come from the CURRENT content's
// WHY:       own lineage (`positionsByIdentity`). The served mirror decides no identity either: it feeds
// WHY:       an evidence-only scan of the lines about to be written (`findServedHashEcho`,
// WHY:       `src/hashline/apply.ts`) and, through `retired`, the set of anchors the RESULT may not be
// WHY:       ASSIGNED to: `loadBlockedHashes` hands them to the identity as `blockedHashes`, and
// WHY:       `markHashUsed` pre-marks those slots, so no line of the new content is given one. A
// WHY:       retired anchor is never refused — only never re-assigned — so it decides no identity
// WHY:       either. A stale row's worst case is a MISS or a fail-closed refusal, never a wrongly
// WHY:       honored line identity.
// WHY: (d) `BEGIN IMMEDIATE` CANNOT NEST: the sweep keeps its own in-transaction guard, so a caller
// WHY:     already inside a transaction still absorbs the sweep instead of opening a second one.
// WHY: (e) The open hooks' `existed` flag keeps its meaning — computed once in `openStore`, cleared on
// WHY:     rebuild — and nothing in this stamp reads or clears it.
const META_VERSION_KEY = "version";
const META_STAMP_KEY = "store_stamp";

/** The stamp's format version — the leading field, bumped only when the field list itself changes. */
const STAMP_FORMAT_VERSION = 1;

/** The value the gate compares against, in the format documented above. */
function storeGenerationStamp(): string {
  return [
    STAMP_FORMAT_VERSION,
    HASH_STORE_VERSION,
    CANON_VERSION,
    ANCHOR_GENERATION,
    openHooks.length,
  ].join(":");
}

/**
 * Whether this store's stamp is current — the ONE fast-path decision of an open, and read-only by
 * construction: the header field, then the two `meta` rows, and nothing else. A file that is not one
 * of ours (no `meta` table yet, a partial build, a corrupt header) has no stamp to match, so the
 * answer is `false` and the slow path heals it; a read never throws out of the open.
 */
function storeStampMatches(db: DatabaseSync): boolean {
  try {
    // SAFETY: `node:sqlite` returns untyped rows; this lists SQLite's own integer header field.
    const header = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    if (header?.user_version !== HASH_STORE_VERSION) return false;
    // SAFETY: untyped rows again — the SELECT lists exactly `key` and `value`, both TEXT NOT NULL.
    const rows = db
      .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
      .all(META_VERSION_KEY, META_STAMP_KEY) as unknown as { key: string; value: string }[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return (
      values.get(META_VERSION_KEY) === String(HASH_STORE_VERSION) &&
      values.get(META_STAMP_KEY) === storeGenerationStamp()
    );
  } catch {
    return false;
  }
}

/**
 * Write BOTH halves of the stamp: the `meta` row carrying the store's provenance, and the header field
 * `PRAGMA user_version` that carries the schema half the gate reads. Called ONLY by `openStore`, and only
 * once EVERY open hook has succeeded, because the stamp certifies the whole open — the build, its
 * migrations, its sweep AND the hook work that follows them. Written from inside `buildStore`, where it
 * used to live, it certifies work that has not happened yet: a hook that throws then leaves a
 * valid-looking stamp over an unfinished store, and the next open takes the fast path over it. The two
 * statements are independent and each is atomic, so an interruption between them leaves a stamp that does
 * not match — one extra slow open, never a store that reads current while it is not.
 */
function writeStoreStamp(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(META_STAMP_KEY, storeGenerationStamp());
  // SAFETY: HASH_STORE_VERSION is this module's own numeric literal constant, never input.
  db.exec(`PRAGMA user_version = ${HASH_STORE_VERSION}`);
}

/**
 * Whether one PERIODIC open item is due, judged by the last-run instant it stores under `key` — one
 * indexed single-row read, so ASKING costs no write and no lock. An item with no record, or with a
 * record that is not an instant, is due: the conservative direction for retention, and the direction
 * that keeps an item running exactly as it did before this mechanism existed.
 */
export function periodicDue(
  db: DatabaseSync,
  key: string,
  intervalMs: number,
  now: number,
): boolean {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    if (row?.value === undefined) return true;
    const lastRun = Number(row.value);
    return !Number.isFinite(lastRun) || now - lastRun >= intervalMs;
  } catch {
    return true;
  }
}

/**
 * Record that a periodic item ran. Written ONLY by a run that did its work: the record is itself a
 * write, so a due-but-idle run must not leave one — it stays due and is asked again next open, which
 * keeps the idle open lock-free and keeps the item's own honesty ("ran" means "did something").
 */
export function markPeriodicRun(db: DatabaseSync, key: string, now: number): void {
  withBusyRetry(() => {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, String(now));
  });
}

// WHY: snapshot-store reads and writes these tables through HashSnapshotIO, so the DDL lives
// WHY: in the schema owner (spec §5.1) and both modules share one definition.
export function ensureSnapshotTables(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS file_snapshots (" +
      "snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "path TEXT NOT NULL, " +
      "snapshot_hash TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "committed INTEGER NOT NULL DEFAULT 1, " +
      "UNIQUE (path, snapshot_hash)" +
      ")",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_snapshots_created ON file_snapshots (created_at)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS line_id_counters (" +
      "path TEXT PRIMARY KEY, " +
      "next_id INTEGER NOT NULL" +
      ")",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS line_lineage (" +
      "snapshot_id INTEGER NOT NULL, " +
      "line_number INTEGER NOT NULL, " +
      "line_id INTEGER NOT NULL, " +
      "canon_hash TEXT NOT NULL, " +
      "anchor TEXT NOT NULL, " +
      "PRIMARY KEY (snapshot_id, line_number), " +
      "FOREIGN KEY (snapshot_id) REFERENCES file_snapshots(snapshot_id) ON DELETE CASCADE" +
      ")",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_snapshot_line_id " +
      "ON line_lineage (snapshot_id, line_id)",
  );
  // WHY: versions the persisted snapshot anchor set — same idiom as file_undo:
  // WHY: rows written before the column read as 0 (unknown/foreign), never current.
  // WHY: `canon_version` (pre-rename builds) is renamed in place, preserving stamped values,
  // WHY: so a pre-rename store opens and its generation-gated behavior is intact; DEFAULT 0 stays
  // WHY: so an older-build row misses and re-derives.
  renameGenerationColumn(db, "file_snapshots");
  // WHY: open-time generation sweep — a pre-bump or poisoned store cannot leave
  // WHY: unknown/foreign-generation snapshots, orphan lineage, or dangling leases
  // WHY: behind. Current-generation rows survive untouched (same-version sessions
  // WHY: keep their leases). The served mirror is TTL-owned, never swept: its
  // WHY: snapshotId is a load-epoch string (`v2|<path>|<ino>|...`), not a
  // WHY: file_snapshots id, so no generation predicate can judge it — TTL pruning
  // WHY: at open owns it, and an absent mirror is recoverable only by a fresh serve.
  // WHY: Runs wherever the schema is ensured, so every store open sweeps.
  // WHY: The four deletes commit as one `BEGIN IMMEDIATE` unit with rollback on error
  // WHY: (the vacuum-evict transaction idiom): a crash between the snapshot sweep and
  // WHY: the orphan-lease delete can no longer strand leases that name no live snapshot
  // WHY: until the next open.
  // WHY: anchor-gated lease prefix — the middle component of the 3-part key
  // WHY: (`${CANON_VERSION}:${ANCHOR_GENERATION}:${checksum}`) is the anchor generation, so a
  // WHY: canon-only change keeps leases while a generation change sweeps them; pre-rename `3:`
  // WHY: 2-part rows carry no middle component and never match, so they sweep as unknown.
  // WHY: (#87c) THE FAST PATH, and the reason the check lives HERE: both sweep call sites funnel
  // WHY: through this one function — `buildStore`'s own call and the snapshot-store open hook's
  // WHY: re-entrant `ensureSnapshotSchema` — so a single check covers both, and a future caller of the
  // WHY: sweep cannot forget it.
  // WHY: (#87d) WHOSE DECISION THIS IS: the store's, read from its stamp — EXCEPT while an open owns this
  // WHY: connection and is in its hook phase, where `buildStore` has already settled the sweep at the
  // WHY: sweep's own site and the stamp is not written yet (`openStamp`): re-deciding from the row there
  // WHY: would sweep a SECOND time on every slow open. Either way the slow path runs ONCE per open.
  // WHY: the DDL above stays unconditional (and takes no write lock once applied) — see trap (a).
  if (sweepSettledByOpen(db) || storeStampMatches(db)) return;

  const anchorLike = `%:${ANCHOR_GENERATION}:%`;
  // WHY: tables created later in the fresh-build path (served_leases) may not exist
  // WHY: yet when this runs — the sweep touches only what is there.
  const hasTable = (table: string): boolean => tableColumns(db, table).size > 0;
  const hasLeases = hasTable("served_leases");
  const sweepGenerations = (): void => {
    if (hasLeases) {
      db.exec(`DELETE FROM served_leases WHERE served_snapshot_hash NOT LIKE '${anchorLike}'`);
    }
    db.exec(`DELETE FROM file_snapshots WHERE anchor_generation != ${ANCHOR_GENERATION}`);
    db.exec(
      "DELETE FROM line_lineage WHERE snapshot_id NOT IN (SELECT snapshot_id FROM file_snapshots)",
    );
    // WHY: one provenance rule as of this sweep — a lease that names no surviving
    // WHY: snapshot for its own path is dangling (same-generation pre-column rows read
    // WHY: as generation 0 and are swept above: a one-time pairing-baseline reset). The grant
    // WHY: lookup is path-scoped (`path = ? AND snapshot_hash = ? AND committed = 1`),
    // WHY: so a lease naming a hash that survives only in a foreign path's row — or only
    // WHY: in an uncommitted row — goes with the orphans.
    // WHY: Scoped to the sweep, not the whole open: the open-hook vacuum runs after and
    // WHY: may evict a snapshot pinned only by a retired-past-grace lease (the vacuum pin
    // WHY: ignores those), stranding its lease until the next open's sweep — fail-closed
    // WHY: (the generation-gated grant misses) and self-healing.
    if (hasLeases) {
      db.exec(
        "DELETE FROM served_leases WHERE NOT EXISTS (SELECT 1 FROM file_snapshots fs " +
          "WHERE fs.path = served_leases.file_path AND fs.snapshot_hash = served_leases.served_snapshot_hash " +
          "AND fs.committed = 1)",
      );
    }
  };
  // SAFETY: `isTransaction` is an experimental `node:sqlite` field the read tolerates as absent
  // SAFETY: (`undefined` reads as not-in-transaction); the read is a boolean guard.
  // SAFETY: `BEGIN IMMEDIATE` cannot nest, so a caller already inside a transaction runs the sweep
  // SAFETY: on that transaction instead of opening its own.
  // SAFETY: the runtime floor is engines.node >= 24, so the read is present on every supported
  // SAFETY: runtime; the same read guards the vacuum-evict and dropServedState paths.
  const inSweepTransaction = (db as unknown as { isTransaction?: boolean }).isTransaction === true;
  if (inSweepTransaction) {
    sweepGenerations();
  } else {
    db.exec("BEGIN IMMEDIATE");
    try {
      sweepGenerations();
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        // SAFETY: best-effort rollback — the original failure is authoritative and must not be masked.
        console.error("[hash-store] failed to rollback sweep transaction:", rollbackError);
      }
      throw error;
    }
  }
}

// WHY: file_undo is the single source of truth for undo history in v7; the DDL lives here
// WHY: (spec §5.1) so the store and the undo domain cannot drift apart.
// WHY: (ticket-04b §4) `transaction_id` correlates the undo rows of one multi-file cut
// WHY: transaction — a column on `file_undo`, deliberately not a new table (ruling); NULL is an
// WHY: ordinary single-file edit. `cut_intent` is the durable intent record written BEFORE the
// WHY: first rename of a cut transaction and deleted when every file of the transaction is
// WHY: committed — its presence at open time marks a half-applied transaction for repair.
const FILE_UNDO_DDL =
  "CREATE TABLE IF NOT EXISTS file_undo (" +
  "path TEXT PRIMARY KEY, " +
  "content TEXT NOT NULL, " +
  "bom TEXT NOT NULL, " +
  "ending TEXT NOT NULL, " +
  "hashes TEXT NOT NULL, " +
  "result_content TEXT NOT NULL, " +
  "snapshot_hash TEXT, " +
  "updated_at INTEGER NOT NULL" +
  ")";

const CUT_INTENT_DDL =
  "CREATE TABLE IF NOT EXISTS cut_intent (" +
  "txn_id TEXT PRIMARY KEY, " +
  "target_path TEXT NOT NULL, " +
  "created_at INTEGER NOT NULL" +
  ")";

// WHY: (04b-rem P2-2/P2-3) `raw_pre` carries the file's RAW pre-transaction text — the decoded
// WHY: bytes, not the canonical fold. The admission round-trip guard (E_LOSSY_TEXT) makes decode
// WHY: and re-encode byte-identical by construction, so a rollback or repair that writes
// WHY: `Buffer.from(raw_pre, "utf-8")` restores EXACTLY the bytes found before the first rename,
// WHY: stray line-break spellings included; NULL is a pre-remediation row (or a single-file edit)
// WHY: and falls back to the canonical serialization.
// WHY: (04b-rem P2-1) `direction` on `cut_intent` marks what the durable record describes: NULL is
// WHY: the forward cut (two renames, target first), "revert" is a correlated UNDO whose per-file
// WHY: writes failed partway — next-run repair completes the revert instead of the cut.
// WHY: (04b-rem P3-6) `transaction_id` is read by equality (`undoGetTransaction`) on EVERY apply
// WHY: (repair scan) and every correlated undo, so it gets an index; the intent scan orders by the
// WHY: unindexed `created_at` over a table that holds at most a handful of rows — ADR-0028 §3's
// WHY: "one indexed SELECT" said otherwise and is corrected there, not here.
export function ensureFileUndoSchema(db: DatabaseSync): void {
  db.exec(FILE_UNDO_DDL);
  addColumnIfMissing(db, "file_undo", "snapshot_hash", "TEXT");
  addColumnIfMissing(db, "file_undo", "transaction_id", "TEXT");
  addColumnIfMissing(db, "file_undo", "raw_pre", "TEXT");
  // WHY: versions the persisted anchor set — existing rows keep 0 (never current),
  // WHY: so a pre-bump store is refused, not migrated, on first open after upgrade.
  // WHY: `canon_version` (pre-rename builds) is renamed in place, preserving stamped values.
  renameGenerationColumn(db, "file_undo");
  db.exec("CREATE INDEX IF NOT EXISTS idx_file_undo_transaction_id ON file_undo (transaction_id)");
  db.exec(CUT_INTENT_DDL);
  addColumnIfMissing(db, "cut_intent", "direction", "TEXT");
}

function buildStore(db: DatabaseSync): boolean {
  // WHY: the open's stamp-due decision is made ONCE here and handed back through `openDb`: it gates the
  // WHY: sweep below and the `version` upsert at the end, and it is what `openStore` owes a stamp write
  // WHY: for once the last hook has succeeded (see `writeStoreStamp`). Nothing here writes the stamp.
  const stampDue = !storeStampMatches(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (" + "key TEXT PRIMARY KEY, " + "value TEXT NOT NULL" + ")",
  );
  // WHY: v7 normalized CAS tables are strictly additive and idempotent — buildStore
  // WHY: never drops them on meta.version mismatch, so a version flap in
  // WHY: mixed-version / multi-worktree environments cannot destroy leases, lineage, or undo pins.
  ensureSnapshotTables(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS served_leases (" +
      "session_id TEXT NOT NULL, " +
      "file_path TEXT NOT NULL, " +
      "anchor TEXT NOT NULL, " +
      "line_id INTEGER NOT NULL, " +
      "canon_hash TEXT NOT NULL, " +
      "served_snapshot_hash TEXT NOT NULL, " +
      "served_line_number INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      "retired_at INTEGER, " +
      "PRIMARY KEY (session_id, file_path, anchor)" +
      ")",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_line " +
      "ON served_leases (session_id, file_path, line_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_line_num " +
      "ON served_leases (session_id, file_path, served_line_number)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_file_retired " +
      "ON served_leases (file_path, retired_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_leases_session_anchor " +
      "ON served_leases (session_id, anchor)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS served_session_meta (" +
      "session_id TEXT NOT NULL, " +
      "file_path TEXT NOT NULL, " +
      "reported TEXT, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY (session_id, file_path)" +
      ")",
  );
  ensureFileUndoSchema(db);
  // WHY: complete v6 compatibility shells keep un-restarted v6 sessions and concurrent
  // WHY: worktrees free of missing-table errors and v6 drop-table wipes, while v7 state
  // WHY: stays isolated in v7 tables. Only the ancient pre-session-keyed served shell is
  // WHY: rebuilt — it is unusable by either version without session_id. The shell keeps its
  // WHY: `canons` column for the same reason: v6 prepares a statement naming it at store open,
  // WHY: so a dropped column would break every v6 store operation. v7 never reads or writes it —
  // WHY: canon evidence is derived from `served_leases.canon_hash` (issue #151).
  if (tableColumns(db, "served").size > 0 && !tableColumns(db, "served").has("session_id")) {
    db.exec("DROP TABLE served");
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS snapshots (" +
      "path TEXT PRIMARY KEY, " +
      "checksum TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
      ")",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS undo (" +
      "path TEXT PRIMARY KEY, " +
      "content TEXT NOT NULL, " +
      "bom TEXT NOT NULL, " +
      "ending TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "result_content TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
      ")",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS served (" +
      "session_id TEXT NOT NULL, " +
      "path TEXT NOT NULL, " +
      "hashes TEXT NOT NULL DEFAULT '[]', " +
      "reported TEXT, " +
      "retired TEXT, " +
      "canons TEXT, " +
      "snapshotId TEXT, " +
      "updated_at INTEGER NOT NULL DEFAULT 0, " +
      "PRIMARY KEY (session_id, path)" +
      ")",
  );
  // WHY: non-destructive column migrations keep pre-existing databases aligned without wipes.
  addColumnIfMissing(db, "served", "retired", "TEXT");
  addColumnIfMissing(db, "served", "canons", "TEXT");
  addColumnIfMissing(db, "served", "snapshotId", "TEXT");
  addColumnIfMissing(db, "undo", "result_content", "TEXT NOT NULL DEFAULT ''");
  // WHY: (#87c) the other half of the fast path: a stamp that is already current records this version
  // WHY: and this generation, so re-writing either would take the write lock on every open to say what
  // WHY: the store already says. The upsert stays exactly where it was — LAST, inside the retry loop and
  // WHY: after the sweep's transaction — so a contended store records its version only once the rest of
  // WHY: the build has settled.
  // WHY: (#87d) this row is NOT one of the stamp's two halves — it is the row the gate also reads — and
  // WHY: its value is a build constant, so it belongs to the build. The halves that certify the WHOLE
  // WHY: open are owed to `openStore` instead: written here they would certify hook work that has not run.
  if (!stampDue) return false;
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(HASH_STORE_VERSION));
  return true;
}

/**
 * The SQLite database header — the 100-byte prefix of every database file, described by the file
 * format spec (`fileformat2.html` §1.3, "The Database Header"). Every field below is read from
 * those bytes directly, which is what makes the smoke check cheap: no page cache, no statement, no
 * lock — one read of the file's first page.
 *
 * WHAT EACH FIELD CARRIES, and the range this check holds it to:
 * - bytes 0-15: the magic string `SQLite format 3\000`. A file without it is not a database.
 * - bytes 16-17: the page size, big-endian, a power of two from 512 to 32768 inclusive — or the
 *   literal value 1, the format's encoding of 65536.
 * - bytes 28-31: the database size in pages, big-endian. The main file's page count only: WAL
 *   frames live outside it (measured — the field equals the file's own page count both while a WAL
 *   is pending and after a checkpoint, on the same store). Zero means "size unknown" to SQLite,
 *   which then derives the size from the file; no open of this store writes zero, so this check
 *   reads it as damage instead of guessing.
 * - the file's length must then be exactly page size x page count.
 */
const SQLITE_MAGIC = "SQLite format 3\0";
const SQLITE_HEADER_BYTES = 100;
const SQLITE_PAGE_SIZE_OFFSET = 16;
const SQLITE_PAGE_COUNT_OFFSET = 28;
/** The format's floor and ceiling for a page size; out of range is not a database. */
const SQLITE_MIN_PAGE_SIZE = 512;
const SQLITE_MAX_PAGE_SIZE = 65536;
/** The header value that ENCODES the ceiling — not a 1-byte page size. */
const SQLITE_MAX_PAGE_SIZE_ENCODING = 1;

/**
 * The FAST path's integrity check (#87c): does this store FILE still look like one SQLite file?
 *
 * WHY a header read replaces the full `PRAGMA quick_check` here: the stamp gate removed the sweep,
 * so the integrity sweep became the dominant remaining cost of a stamp-matching open — it walks
 * every page of the store — and what it buys is EARLIER notice, not prevention. The remedy for a
 * damaged store is `quarantineStore` plus a rebuild from empty, because this store is a
 * disposable CACHE: the served mirror, the snapshots and their lineage are all re-derived from the
 * files on disk on the next read. Paying the dominant share of every process's open latency, on
 * every open, to move that notice a few statements earlier was the bad trade.
 *
 * WHAT IS DELIBERATELY NOT CHECKED, and where the check MOVES to instead: page-level damage inside
 * an otherwise well-formed file — a torn b-tree page, a freelist that disagrees with itself — is
 * not visible from the header. Such corruption surfaces LATER, at the statement that first touches
 * the damaged page, as its own error (`database disk image is malformed`, SQLITE_CORRUPT), never
 * as a silently wrong result: every honoring path re-derives from the bytes it is about (see the
 * trap-(c) block above). Issue #90 INHERITS the throttled deep check: its janitor sweep runs the
 * store's own maintenance off the tool-call path, so the deep pass is MOVED rather than lost.
 */
function smokeCheckStoreFile(storePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(storePath, "r");
    // SAFETY: allocUnsafe is safe here because readSync fills all 100 bytes before any of them is
    // SAFETY: read — the `read < SQLITE_HEADER_BYTES` guard below rejects a short read first.
    const header = Buffer.allocUnsafe(SQLITE_HEADER_BYTES);
    const read = readSync(fd, header, 0, SQLITE_HEADER_BYTES, 0);
    if (read < SQLITE_HEADER_BYTES) return false;
    if (header.toString("latin1", 0, 16) !== SQLITE_MAGIC) return false;
    const rawPageSize = header.readUInt16BE(SQLITE_PAGE_SIZE_OFFSET);
    const pageSize =
      rawPageSize === SQLITE_MAX_PAGE_SIZE_ENCODING ? SQLITE_MAX_PAGE_SIZE : rawPageSize;
    if (pageSize < SQLITE_MIN_PAGE_SIZE || pageSize > SQLITE_MAX_PAGE_SIZE) return false;
    if ((pageSize & (pageSize - 1)) !== 0) return false;
    const pageCount = header.readUInt32BE(SQLITE_PAGE_COUNT_OFFSET);
    if (pageCount === 0) return false;
    return fstatSync(fd).size === pageSize * pageCount;
  } catch {
    // WHY: a file that cannot be read at all cannot be a healthy store — and the CALLER decides
    // WHY: what that means (quarantine and rebuild), so this check reports only its verdict.
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // SAFETY: closing a read-only descriptor this call opened; a failure leaves no lock, no
        // SAFETY: write and no state behind, and the verdict above is already decided.
      }
    }
  }
}

/**
 * The SLOW path's integrity check: SQLite's own full pass over the store, unchanged. Runs when
 * there is no stamp to trust — a fresh store, a stamp mismatch, `existed === false`, or the open
 * that follows a quarantine — where the open is already building or rebuilding from empty, so a
 * pass over every page is not the latency being avoided.
 */
function isHealthy(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return row?.quick_check === "ok";
  } catch (error) {
    if (isCorruptionError(error)) return false;
    return true;
  }
}

async function quarantineStore(storePath: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  for (const candidate of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
    try {
      await rename(candidate, `${candidate}${suffix}`);
    } catch (error) {
      if (errCode(error) !== "ENOENT") {
        console.error("Failed to quarantine corrupt hash store file:", error);
      }
    }
  }
}

function shutdownDb(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error: unknown) {
    console.error("[hash-store] failed to checkpoint WAL on shutdown:", error);
  }
  db.close();
}

async function openStore(storePath: string, budget?: BusyBudget): Promise<HashStore> {
  shutdownHashStore();

  await initHasher();
  await mkdir(hashStoreDir(), { recursive: true });

  let existed = existsSync(storePath);
  let opened: OpenedDb;
  try {
    opened = openDbWithBusyRetry(storePath, budget);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    console.error("Hash store failed to open, rebuilding:", error);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath, budget);
  }
  let db = opened.db;
  // WHY: (#87c) WHICH integrity check an open pays follows from the stamp, because the stamp is the
  // WHY: store's own record that its provenance is current. `existed` is read before the open and
  // WHY: cleared by either recovery path below, so a store this open CREATED — or just rebuilt after
  // WHY: quarantine — is never handed to the header check: it has no settled identity yet, and the
  // WHY: open is already doing the expensive work. Both arms fence the same single failure shape,
  // WHY: `false`, so the recovery below is shared rather than duplicated per check.
  const stampTrusted = existed && !opened.stampDue;
  if (stampTrusted ? !smokeCheckStoreFile(storePath) : !isHealthy(db)) {
    shutdownDb(db);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath, budget);
    db = opened.db;
  }

  // WHY: the open's own stamp decision, in memory from here to the end of the open: the hooks' re-entrant
  // WHY: ensures consult it (`sweepSettledByOpen`) rather than a stamp this open has not written yet, and
  // WHY: the stamp write below is owed exactly when it says so.
  const stamp = { db, due: opened.stampDue };
  openStamp = stamp;
  try {
    for (const hook of openHooks) {
      await hook(db, { existed });
    }

    // WHY: (#87d) THE STAMP IS THE OPEN'S LAST STEP: both halves, written together, and only now that
    // WHY: EVERY hook has succeeded — they certify the whole open, the build, migrations and sweep that
    // WHY: `openDb` ran included. Written inside the build they certify work that has not happened yet,
    // WHY: so a hook that throws leaves a valid-looking stamp over an unfinished store and the next open
    // WHY: takes the fast path over it. This write is also OUTSIDE `openDbWithBusyRetry`'s envelope (the
    // WHY: open's last write, after the hook loop), so it carries its own retry: without one, a store that
    // WHY: is merely busy this instant would fail an open that has already done all of its work.
    if (stamp.due) withBusyRetry(() => writeStoreStamp(db), budget);

    cachedDb = { path: storePath, db };

    if (!exitHandlerRegistered) {
      exitHandlerRegistered = true;
      process.once("exit", () => shutdownHashStore());
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, () => {
          shutdownHashStore();
          process.kill(process.pid, sig);
        });
      }
    }

    return { db, engine: "node:sqlite" };
  } finally {
    // WHY: NOT housekeeping, and not defensive tidiness: this clear is what keeps the slot to the hook
    // WHY: phase. The slot answers one question — "is an open in its hook phase on THIS connection" —
    // WHY: and leaving it set lets the next ensure on the still-open connection read a spent decision:
    // WHY: `sweepSettledByOpen` matches the live handle, so an ensure that runs OUTSIDE an open —
    // WHY: `ensureSnapshotTables` called directly, which is how seven committed tests sweep after moving
    // WHY: the stamp (`test/integration/undo-generation-bump.test.ts`, "generation bump refuses pre-v3
    // WHY: anchors") — silently SKIPS the sweep it owes, and the rows it had to remove survive. Delete
    // WHY: this line and those seven tests fail.
    openStamp = null;
  }
}

/**
 * Open (or return the cached) store. `budget` shapes the contention wait of THIS open; production
 * callers pass nothing, and a cached open returns immediately without consulting it.
 */
export function loadHashStore(budget?: BusyBudget): Promise<HashStore> {
  const storePath = hashStorePath();
  if (cachedDb && cachedDb.path === storePath && cachedDb.db.isOpen) {
    return Promise.resolve({ db: cachedDb.db, engine: "node:sqlite" });
  }
  if (opening && opening.path === storePath) {
    return opening.promise;
  }
  const promise = openStore(storePath, budget).finally(() => {
    if (opening?.path === storePath) opening = null;
  });
  opening = { path: storePath, promise };
  return promise;
}

export function shutdownHashStore(): void {
  if (cachedDb) {
    shutdownDb(cachedDb.db);
    cachedDb = null;
  }
}

export function withStore(fn: () => void): void {
  if (!cachedDb || !cachedDb.db.isOpen) {
    throw new Error(
      "withStore requires an open SQLite store — call loadHashStore() first or use a MemoryStore in tests",
    );
  }
  withBusyRetry(() => {
    cachedDb!.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      cachedDb!.db.exec("COMMIT");
    } catch (e) {
      try {
        cachedDb!.db.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        console.error("[hash-store] failed to rollback transaction:", rollbackError);
      }
      throw e;
    }
  });
}

export function __isStoreOpen(): boolean {
  return cachedDb !== null && cachedDb.db.isOpen;
}
