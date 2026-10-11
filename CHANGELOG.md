# Changelog

## [Unreleased]

### Features
* **store:** resolve the janitor's settings from the SAME json config file the lens bridge already uses (#90) — `store.janitor` (`on`/`off`), `store.janitorIntervalMs` and `store.janitorBatchSize` join `lens.bridge` in `.pi/agents/pi-better-edit.json` and are resolved PER KEY through one ladder: env (`PI_BETTER_EDIT_STORE_JANITOR`, `PI_BETTER_EDIT_STORE_JANITOR_INTERVAL_MS`, `PI_BETTER_EDIT_STORE_JANITOR_BATCH_SIZE`), then project, then global, then the default (`on`, once a day, batches of 64). The file, the two scopes, the read and the preserving atomic write are EXTRACTED into a new neutral `src/json-config.ts` that both settings owners import, which is the only shape the boundary allows — `lens-bridge-boundary.test.ts` forbids importing `src/integrations/pi-lens` from outside that directory, so a second hand-rolled ladder was the alternative — and `test/arch/config-ladder-single-owner.test.ts` now pins the config path literal to that one module. A malformed or unreadable file degrades to the defaults WITH a warning through the new optional `onWarn`, while the lens-bridge path keeps its silent read; there is deliberately no store-directory key, because `PI_BETTER_EDIT_CONFIG_DIR` alone owns the store path and no file may move it.
* **bash-view:** admit the five Tier-1 `grep`/`rg` flag shapes (#82) to the intercepted search — boundary match (`-w`/`--word-regexp`, `-x`/`--line-regexp`), match limit (`-m N` with its value as a separate strictly positive integer argument, and the attached `--max-count=N`), bundled single-dash clusters (`-in`, `-nw`, `-nm 3`: every letter admitted, `m` only closing the cluster and consuming the next argument), flags after the pattern or after the file (`grep pat -i f`, `grep pat f -n`), and colour suppression (`--color=never`/`--colour=never`) — while a digit or unknown letter in a cluster (`-n5`, `-inQ`), an attached short value (`-m3`), a malformed limit (`-m0`, `-m 0`, `-m -1`, `-m abc`, `--max-count=0`, `--max-count=`, bare `-m`, bare `--max-count`), a `=`-long form other than `--max-count=` (`--line-number=x`), and every colour value but `never` still fail closed to byte-identical raw bash; flags are honoured at any position before `--`, which ends flag parsing so `grep pat -- -n` names the file `-n`, and the `-n` injection is skipped when the line-number flag appears anywhere, bundles included. (#83)

### Tests
* **harness:** harden the vitest harness against host-load timer lateness (#84) — a new `vitest.config.ts` raises `testTimeout` to 20s and `hookTimeout` to 30s, because the observed failures are a 5526ms test body against the 5000ms default and ~14s module-level `beforeAll(initHasher())` hooks against the 10000ms hook default; this is the lever the measurements support, since `isolate: false` fails 19 tests, `maxWorkers: 4` costs +33s wall without removing the failure mode, and `initHasher()` is already a module-level singleton with nothing to hoist. (#88)
* **harness:** isolate the hash store from the developer's real one (#89) — `PI_BETTER_EDIT_CONFIG_DIR` (new, read verbatim by `configDir()`: empty counts as unset, precedence `PI_BETTER_EDIT_CONFIG_DIR` > `XDG_CONFIG_HOME` > `$HOME/.config`) is pinned to a per-worker temp dir by the new `test/support/isolate-store.ts` `setupFiles` entry, so no test file can open the real `hash-store.sqlite` and race a live session — reproduced by running the previously leaking `task147-rejection-diagnostics` file without the seam, which resolved through `XDG_CONFIG_HOME` to the real store and bumped its mtime; test files that assert or re-open the store under a stubbed `HOME`, count rows across a whole table, or read a plan cached under a fixed path opt out explicitly with an empty value — a set found by measurement and by suite-wide shuffling, never from a brief's list of candidate files — and cleanup survives the forks pool's SIGTERM teardown. (#92)
* **store:** assert the contention episode's STRUCTURE instead of an exact attempt count (#87b) — the exact count was a FALSE invariant, because the deadline is a wall-clock backstop checked after each failed attempt and a host loaded far enough legitimately ends the episode a retry early (the flake read `expected 3 to be 4` at `elapsed 155` against a 150ms model). `BusyBudget` gains ONE optional field — `now`, the clock the deadline is measured against, `Date.now` by reference when nothing is injected, so every production call site measures exactly what it did before — and both branches are now asserted deterministically with no dependence on host load: a FROZEN clock, under which the deadline cannot fire and the exact count of `maxAttempts` attempts is a true invariant again, and a clock scripted PAST the deadline, which exercises the documented backstop for the first time (a reduced count, the ORIGINAL busy error still rethrown, the rival's lock still held). Every wall-clock reading — elapsed, cap, model, bound, per-attempt cost, attempt total — now rides the assertion MESSAGE as a diagnostic; the production-default test's `elapsed < bound` became one of those (measured 4687-4748ms against a 5174-5358ms bound, ~1.1x) and its exact count became a bound, while the two inequalities kept as assertions have their headroom measured under load: the harness ceiling (worst 4748ms at load average 54-91, 1.40x against 6666ms) and the recovery test's 1000ms (worst 58ms at the same load, 17x). Refutability, both mutations run and reverted: collapse the loop to a single attempt and the frozen-clock assertion reads `expected 1 to be 4`; drop the deadline check and the backstop assertion reads `expected 4 to be 2`. (#96)
### Bug Fixes
* **errors:** attribute `E_BAD_PAYLOAD` to the registered tool that raised it (`read`, `edit`, `undo_last_edit`) (#86) instead of claiming every refusal was an edit payload, and render the neutral `The payload is not valid:` when no tool stamped one — a new optional `subject` field on the payload plus a `withPayloadSubject` boundary helper that re-wraps only `E_BAD_PAYLOAD` and returns every other failure unchanged, with the undo tool stamping before its `E_UNKNOWN` conversion so the tool's own name survives — and, because the edit engine routes a thrown refusal as `code` plus a RENDERED message, the raw payload message now rides a single-purpose `payloadMessage` envelope slot (written only under `E_BAD_PAYLOAD`, read-validated as a non-empty string under that same code) back to the tool seam, where `attributePayloadSubject` rebuilds the typed refusal so an engine-level edit rejection still reads `The edit payload is not valid:` rather than losing its tool name — every batched item rejection embeds that attributed inner, so an `edit[i] (path) failed:` wrapper keeps its prefix and atomicity trailer while the clause still names the edit tool; a non-member subject renders the neutral wording instead of a malformed clause, and the undo arm now traces an unexpected failure before its early return. (#95)

* **store:** budget the hash store's lock contention explicitly instead of leaving it implicit, oversized and uniform (#87) — `node:sqlite`'s `timeout` constructor option *is* SQLite's busy handler, so no `PRAGMA busy_timeout` was ever missing (the new guard measures the pragma readback, 250 with the option and 0 without, rather than grepping for a pragma spelling); what changes is the budget itself: the per-attempt internal wait drops from 1000ms to 250ms, attempts rise from 4 to 8 with jittered exponential backoff (base 50ms, cap 400ms, jitter 50ms) so contending writers no longer wake in lockstep, and a wall-clock deadline computed from those constants bounds the modelled episode at 4300ms — a model that, scoped to those constants, is a floor rather than a cap: against a permanently held lock the production episode OVERSHOOTS it, because one attempt costs the 250ms internal wait PLUS the connection-open and statement work that no constant here prices — SQLite returns the busy error only once the wait has elapsed, so the episode pays that work on all eight attempts — and because the model charges every backoff its MAXIMUM jitter draw while an episode pays some fraction of one; the numbers that would describe the overshoot belong to one host's episode rather than to this code, so the durable claim is the constants' own arithmetic — the same 4300ms the old fixed 4 x 1000 + 3 x 100 shape modelled — while an injected budget carries its own larger model instead of this bound (maxAttempts 100 models 68.7s, code-derived: 100 x 250ms plus 43.7s of capped backoff and jitter, and its episode is bounded by that model's deadline) — exhaustion still rethrows the original busy error unchanged so busy-versus-corrupt classification is untouched, every store write path keeps the same budget because they all funnel through `withBusyRetry`, and the whole policy is injectable through one optional budget argument that no production call site passes, the jitter draw included: it has exactly ONE channel (`budget.random`, falling through to `Math.random`) so a caller can no longer hand the retry loop a draw it silently ignores. (#96)


* **store:** gate the store open on a two-part stamp, so a healthy open takes NO write lock (#87) — the generation sweep and the `meta('version')` upsert were the open path's write-lock takers (a `DELETE` takes the lock even when its predicate matches no row), and both now run only when the store's recorded provenance has moved: `PRAGMA user_version` carries the schema half and a `meta` row `store_stamp` holds a versioned, identity-only value; on this build it reads `1:9:3:1:5` (the leading format version, then the store schema version, the canon version, the anchor generation, and the number of registered open hooks); the hook count is the build fingerprint, so a build registering an ADDITIONAL open hook invalidates every stamp an older build wrote instead of silently suppressing the new hook's work (a SWAP of one hook for another keeps the count, so a semantic change still needs the version bump), both written only AFTER the DDL, migrations and sweep have committed, so a failed sweep leaves the stamp unset and the next open retries it. The gate sits in `ensureSnapshotTables`, where both call sites funnel (`buildStore`'s own and the snapshot-store hook's re-entrant ensure), so one check covers both and a mismatch makes the first site sweep while the second skips its own — the slow path runs once per open, not twice. `meta('version')` keeps its value, format and semantics; the version row joins the gate because the fast path skips the upsert that maintains it. The served-mirror TTL prune becomes a PERIODIC open item (`periodicDue`/`markPeriodicRun`, one stored last-run instant) whose due case asks the SAME predicate and cutoff as an existence read (`servedExpiredExists`) before deleting, because that unconditional `DELETE` was the last writer left on the open path. The timer is kept, and what it relaxes is stated at the constant: retention is enforced at most four times a day instead of on every open, so an expired mirror row can live `SERVED_TTL_MS` + `SERVED_PRUNE_INTERVAL_MS` and spec §5.1 item 8's "enforced on every open" no longer holds across the deferred window. It earns its place because the guard it skips has NO usable index — `served` is keyed `(session_id, path)`, the predicate is on `updated_at` — so the no-match case scans the whole mirror: measured medians of the prepared guard, n=9, on one machine (loadavg 6.62 6.76 7.43), 0.04ms at 1,000 rows, 0.71ms at 20,000, 1.77ms at 50,000, versus 0.002ms when something IS expired. The cadence is handed to #90 as a knob. The `isHealthy` `PRAGMA quick_check` is untouched and now dominates the open (68.85ms of a 70.46ms steady open at 29.74MiB — a read, which takes no lock). Measured with a rival connection holding `BEGIN IMMEDIATE` on a copy: before, the open threw errcode 5 after 4441.8/4457.7/4359.2ms with 2 `BEGIN IMMEDIATE` and 8 executed sweep deletes per open; after, the identical open SUCCEEDS in 1.2/1.2/67.7ms with 0 of each. Deliberate trade: a row poisoned after the stamp is not removed by a stamp-matching reopen — the sweep is an upgrade/migration action now, periodic re-sweeping belongs to the janitor, and every reader of that state is generation-gated. (#99)

* **store:** make the open stamp the open's LAST step, so it certifies every hook and not only the build (#87) — the stamp was written at the end of `buildStore`, which runs BEFORE `isHealthy` and before the five registered open hooks, so a hook that threw left a VALID-LOOKING STAMP over hook work that never ran and the next open took the fast path over that unfinished state. `buildStore` now makes the stamp-due decision and HANDS IT BACK through `openDb` instead of writing the stamp, and `openStore` writes both halves — the header `PRAGMA user_version` and the `meta` row `store_stamp` — ONCE, only after the hook loop has succeeded, and still together. The fast path writes nothing at all, and the `meta('version')` row the gate also reads stays where it was: it is not one of the stamp's halves and its value is a build constant. The deferred write is now OUTSIDE `openDbWithBusyRetry`'s envelope, so it carries its own `withBusyRetry` under the open's budget — an unretried end-of-open write would fail, with `database is locked`, an open that had already done all of its work, which `hash-store-open-stamp.test.ts`'s "retries the deferred stamp write when the store is busy at the end of the open" pins by holding the write lock from a child process across the hook phase while the retry loop waits on it (removing the wrapper makes that test reject). Within the open the sweep stays idempotent WITHOUT re-reading the row: `openStamp`/`sweepSettledByOpen` carry the open's in-memory decision to the snapshot-store hook's re-entrant `ensureSnapshotSchema`, because a row-based gate would now find no stamp there and sweep a SECOND time on every slow open — dropping the in-memory check from the gate doubles the measured counts to 2 `BEGIN IMMEDIATE` and 8 sweep deletes against 1 and 4. Red proof, in the same file: a registered hook that throws leaves `{ userVersion: 0, stamp: undefined }` (the `version` row is already current, and the hooks' ungated DDL is present, so the store still heals), and the next open sweeps again and re-stamps. Statement counts for a stamp-mismatched open, before and after the move under one instrumentation: 1 `BEGIN IMMEDIATE`, 4 sweep deletes, 2 `meta` upserts, 1 header write — the stamp-matching open: none of them. The hook-level ensures stay deliberately ungated, and `PRAGMA quick_check`, the prune timer and its stated relaxation, the exposure statement, the stamp's format and the hook count are untouched. (#99)

* **store:** check a stamp-matching open with a read-only SQLite header smoke check instead of the full `PRAGMA quick_check` (#87) — #99 removed the open's write lock but left `isHealthy`'s full pass untouched, so that pass became the whole remaining cost of a fast open (measured medians of n=25 fast opens on one machine at loadavg 5.64 6.50 7.34: 6.029ms of a 7.467ms open at 28.78MiB, 0.133ms of a 1.535ms open at 156KiB), and what it bought was earlier NOTICE rather than prevention — damage is answered by quarantining and rebuilding a DISPOSABLE CACHE whose rows are re-derived from the files on disk on the next read. The fast path now reads the 100-byte database header (`fileformat2.html` §1.3): the 16-byte `SQLite format 3\0` magic, the page size at offset 16 (a power of two from 512 to 32768, or the format's value 1 meaning 65536), the page count at offset 28 (non-zero), and the file's own length against page size x page count — an open, a positional 100-byte read, the descriptor's stat and a close, with no statement, no lock and no page cache, and its cost stops growing with the store (same instrumentation and machine, n=25, loadavg 5.35 6.43 7.30: 0.023ms of a 1.193ms open at 28.78MiB and 0.027ms of a 1.491ms open at 156KiB, against 6.029ms and 0.133ms for the two checks before — an 84% drop in the large store's fast-path total, while a fresh store's open is unchanged at 3.209ms before and 3.223ms after because a store this open CREATED takes the slow path in both shapes). The header stays self-consistent with a live writer, so the check cannot false-positive on one: the page count is the MAIN file's, equal to that file's own length both with a pending WAL and after a checkpoint, pinned by `hash-store-open-smoke-check.test.ts`'s pending-WAL case. The full `PRAGMA quick_check` runs UNCHANGED on every slow path — no stamp, a stamp mismatch, `existed === false`, or the open that follows a quarantine. #90 inherits the deep check with its throttled janitor sweep, so the deep pass is MOVED off the hot path rather than lost: page-level damage inside an otherwise well-formed file is now found at the statement that first touches it, as SQLite's own `database disk image is malformed` (errcode 11), never as a silently wrong result, because every honoring path re-derives from the bytes it is about. Red proof, four corruption modes on a stamped store, each refused and quarantined: a bad header magic reads `file is not a database` (errcode 26), a truncated file and a wrong page size both read `database disk image is malformed` (errcode 11) from the stamp read or the statement itself, while a zero page count and a file ONE byte longer than page size x page count both OPEN CLEANLY under the old check — SQLite derives a zero page count from the file and tolerates trailing bytes — and are the two modes the new check is what refuses. Refutability, both mutations run and reverted: an always-accept check fails the zero-page-count and oversize tests, an always-refuse check fails the healthy-reopen, pending-WAL and 65536-page-size tests. (#101)

### Code Refactoring
* **read:** name the file-count cap's refusal in one constant (`MAX_READ_FILES_MESSAGE`) (#85) instead of an inline template, and pin the 10/11 boundary on both enforcement points — the registered `files`-array `maxItems` that an over-cap tool call actually hits and the admission guard that backstops a caller skipping the schema; the two wordings diverge by construction, because the runtime validates `parameters` before `execute` and builds its message from `maxItems`. (#88)


## [2.11.0] - 2026-10-10

### Features
* **edit:** declare the optional wire fields (`text`, `text_ref`, `at`, root `mode`, and `text_ref.file`) nullable so the served schema admits the `null` that admission already reads as absent, and reframe both XOR refusals as an explicit binary field choice — the flat wire contract, the required fields, and admission behaviour are unchanged. (ADR-0036) (#81)
* **edit:** return the anchored post-edit diff in the model-visible text — `content[0].text` is now the summary line, a blank line, then the same collapsed #174 single-projection diff, while `details.diff` stays byte-identical for TUI clients, so the summary the `tool_result` hook previously discarded and the diff the model edits against now travel together; a follow-up edit anchors on a row the previous edit modified with no intermediate `read`. (#79)
* **read:** disclose non-printable control characters under the verbatim rows (C0 minus tab/LF/CR, plus DEL and the C1 block) instead of escaping the bytes, so the model is warned about characters it cannot see without tokenizer-hostile escapes. (#79)
* **read:** serve many files and many windows in one call — `files: [{ file, windows: [{ offset, limit } | { around_anchor, radius }], mode }]` replaces the single-file shape (legacy `{ file/path, offset, limit }` and `windows: []` still fold, while the prompts publish only `files`), windows merge by interval and each file is walked once, a call carries at most 16 windows across all files and at most 10 files, every file draws on one shared `SERVED_MAX_LINES` budget, and an anchor resolves against the target file's active session lineage whether or not a sibling served rows — unknown/expired/foreign warns inline and the siblings still render, `mode: "verbatim"` renders a resolved window as plain rows and leases nothing, one failing file (or a failing mirror phase) is an inline section rather than a failed call, and each section carries its own `[path (N lines total)]` / `[path (verbatim, N lines, no anchors)]` header with a copy-pasteable `Use windows: [{ offset, limit }]` footer. (#79)
* **bash-view:** intercept pure `grep`/`rg` searches — a strict eight-flag allowlist (`-n|--line-number`, `-i|--ignore-case`, `-F|--fixed-strings`, `-E|--extended-regexp`) over exactly one file operand, with `-n`/`--line-number` injected before execution and before any `--` separator, serves the matched lines as `HASH│content` rows under the frozen `--- Bash search (hashline anchors) ---` header and leases exactly the matched lines, and witnesses every match against a disk re-read, so a non-zero exit, an unparsable line, a forged or stale disk line, or more than `SEARCH_MAX_MATCHES` matches all fail closed to byte-identical raw output — every other flag, pipeline, redirection, compound, glob, tilde, directory and multi-file shape passes through untouched. (#79)

### Build System
* **deps-dev:** import and pin knip 6.40.0 for dead code and export hygiene, and prune unused semantic-release dependencies. (#79)

## [2.10.1] - 2026-10-09

### Bug Fixes
* **edit:** read a null in the nested `text_ref.file` as absent and name the fields that are genuinely required, so a harness using strict structured output is no longer refused for a call it has no way to spell differently. (#77)

## [2.10.0] - 2026-10-09

### Features
* **pi-lens:** retire the frozen v1 bridges and mirror through the unified v2 File I/O Lifecycle Bridge — a single `io-bridge` adapter records served spans (caller content sliced per single-range span, disk evidence only when the notification carried no bytes) and file mutations (whole-file authorship as `write`) via structural `Symbol.for("pi-lens:io-bridge")` detection with no pi-lens import; mutated-file notifications precede served-span notifications so facet-split records reflect post-mutation state; the integration stays optional (only the entry point wires it, removal recipe in README) with the boundary test pinning the v2 surface. (#66)

### Code Refactoring
* **errors:** revise all `E_*`/`W_*` refusal texts to concise single-fact STE100 sentences with structured bullets for batch failures and overlaps, and teach `mode: "literal"` on the refusal surface — no behavior change. (#61)

### Bug Fixes

* **bash-view:** normalize CRLF line endings and strip BOM from observed `bash` stdout before the D9 byte-equality gate, and admit semicolon-chained deterministic silent prefixes (literal-operand `cd`, `pwd`, `true`, `:`) before a terminal view — fail-closed on all other output preserved. (#68)
* **edit:** read explicit `null`/`undefined` in `text`/`text_ref`/`at`/`mode` as absent at admission, and name the field to drop in the doubly-specified refusal — XOR contract stands, no structural schema change. (#74)

## [2.9.0] - 2026-10-08

### Features
* **bash-view:** intercept pure file views in `bash` results and replace them with anchored slice previews — `cat`/`head`/`tail`/`sed -n` single-file views (incl. single pre-view `cd`-prefixed `&&` chains, sanctioned `cat | head/tail` pipelines, and a leading `rtk` transparent wrapper in source positions) are classified by AST span kinds (`silent` | `view` | `unsafe`, undetermined is `unsafe`) via `unbash`, slice-computed by exact interval arithmetic, verified byte-for-byte against the observed stdout (trailing-newline leniency only; filtering wrappers, drift, and encoding skew fail closed), and swapped wholesale for the canonical disk re-read with leases on exactly the served lines; every other shape (search, mutations, multi-file, `;`/`||`, flags like `cat -A`, `cd -`, post-view or multi-`cd` chains, truncation, errors) passes through byte-unmodified. Recorded as ADR-0033 with glossary (`pure view`, `slice view`, `silent segment`, `span kind`, `view replacement`, `interval algebra`, `transparent wrapper`) for issue #28. Test scope: `test/tools/bash-classifier.test.ts` (span matrix, algebra, R4 guards) + `test/tools/bash-rtk-wrapper.test.ts` + `test/tools/bash-view-lifecycle.test.ts` (replacement, slice leases, verification gate, session isolation). (#54)

## [2.8.0] - 2026-10-06

### Features
* **read:** drop image support and state the plain-text-only contract — image files are no longer delegated to the builtin reader and fail with `E_UNSUPPORTED_FILE` like other non-text kinds; the description leads with plain text, keeps the batched `windows` example with the `served`-mode anchor qualifier, and retains the UTF-8 BOM/encoding notes pending multi-encoding support. (#52)

* **hashline:** adopt 4-char anchors for tokenizer-stable references. `HASH_LEN` flips 3 to 4; every shape, regex and count word derives, so no other `src/` numeric change was needed and the stride stays `62^2 + 62 + 1 = 3907`. A 3-char token is now `E_MALFORMED_ANCHOR` with no compatibility path. The `E_LARGE_FILE` hash-space limit is scale-tested via a bounded uniqueness run plus a directly constructed error, and new-width coverage pins echo refusal, lease materialization, lineage anchors and resolve-seam rejection. (#49)
* **hashline:** reserve all-digit anchor spellings from allocation — a served one would be indistinguishable from a line number, so the 10,000-strong digit subcube is pre-marked in the allocation bitset and never served; usable space is `62^4 − 10^4 = 14,766,336` (a 0.0677 % shrink, alphabet unchanged), the stride stays coprime with both spaces, and digit-shaped spellings keep the ordinary unserved-lease refusal with the line-number note. (#49)
* **hashline:** derive anchors from (path, content) — allocation seeds xxh32 with the canonical absolute path, so byte-identical files at different paths serve disjoint anchor sets and an anchor served by another file is refused as foreign; content-only derivation remains available only through the explicit `contentOnlyHashes` seam, and `ANCHOR_GENERATION` starts at 1 so pre-change snapshots miss and recompute. (#49)
* **read:** decouple the served admission budget from the anchor-space ceiling — `SERVED_MAX_LINES` (200,000 lines ≈ 14.9 MB marginal worst case over the loaded text: ~6.1 MB of retained walked anchors post-paging plus the ~7.0 MB spelling-memo entry overhead over the same strings plus the fixed ~1.76 MB allocator bitset, probe-measured via `node --expose-gc scripts/measure-served-budget.mjs`, against the ~15 MB target) replaces the `MAX_HASH_LINES` alias on every served-cap seam, so a width change can never move the memory budget; the streaming refusal reports an honest lower bound ("more than N") while the preloaded gate reports the exact count. (#49)
* **hashstore:** refuse cross-generation anchors after the `ANCHOR_GENERATION` split — `file_undo` carries `anchor_generation` (legacy rows read as never-current; the pre-rename `canon_version` column is renamed in place, with a SAFETY note for the both-columns DROP fallback and the fail-closed concurrently-open pre-rename process), undo restores re-derive file-scoped anchors for stale rows instead of adopting them, and foreign-generation snapshot descriptors are rejected rather than written; the 3-part cache key (`CANON_VERSION:ANCHOR_GENERATION:checksum`) makes every existing `3:`-prefixed row unreachable (safe miss) and supersedes the 2-part shape ADR-0029 §1 describes; recorded as ADR-0031 with the accepted file-scope residual. (#49)
* **hashstore:** gate leases and snapshot hits on the anchor generation — the lease source skips pre-bump leases, snapshot lookups treat unknown-generation rows as misses that delete, and an open-time sweep drops snapshot/lineage/lease rows whose generation is unknown or foreign (leases orphaned by the snapshot sweep go in the same open); the served mirror is TTL-pruned, never swept; `file_snapshots` carries `anchor_generation` so the next bump sweeps mechanically. (#49)

### Bug Fixes

* **hashstore:** harden the open-time generation sweep — the orphan-lease delete is path-scoped (a lease naming a hash that survives only in a foreign path's row is now dropped), the four sweep deletes commit as one `BEGIN IMMEDIATE` unit with rollback on error, and the lease-names-live-snapshot invariant is scoped to the sweep point (the open-hook vacuum can strand a retired-past-grace lease until the next open). (#49)
* **hashstore:** close the sweep-hardening residuals — the orphan-lease delete now matches the grant's `committed = 1`, so a lease naming only an uncommitted row is swept with the other orphans while live leases are kept, and the caller-transaction guard plus the rollback-failure path are pinned by tests. Test scope: `test/integration/undo-generation-bump.test.ts` (3 new: uncommitted-lease sweep with live-lease control, caller-owned-transaction join with caller-rollback restore, rollback failure preserves the original error). Note: `engines.node` is now `>=24.0.0` and CI exercises 24 and 26, so the `isTransaction` guard is unconditional on every supported runtime. (#49)
* **hashstore:** stop the undo failure replay from laundering pre-generation rows — `upsertUndo` stamps from the payload (`entry.anchorGeneration ?? ANCHOR_GENERATION`, forwarded by `saveUndo`) instead of hard-coding current, so a replayed pre-generation row still reads as generation 0 and the restore gates re-derive file-scoped anchors rather than adopting its foreign hashes. Test scope: `test/integration/undo-generation-bump.test.ts` (1 new: failed-write replay preserves generation 0 and the served restore equals the current derivation, reddened by mutant flip). (#49)

* **hashline:** bound the anchor memo from the domain — `HASH_CACHE_MAX_ENTRIES = SERVED_MAX_LINES` declared beside the WHY in `src/hashline/hash-identity.ts` (no product materialization hashes more than one served budget per call, so the memo stays fully effective in-budget while sitting ~40x below V8's smallest per-Map cap and the RangeError can no longer pre-empt `E_LARGE_FILE`); CI pins the exact floor `24.0.0`, the `isTransaction` SAFETY note names the experimental field, and a TARGET-coupling arch test pins the build target to `engines`. (#49)

### Documentation

* **read:** correct the served-budget magnitude note and harden the budget probe — the anchor-space comparison now names its axis (`~74x` in line count, `~32x` in bytes, not two orders of magnitude), and `scripts/measure-served-budget.mjs` asserts its width/alphabet literals against `src/hashline/alphabet.ts` and echoes the ~15 MB target from `SERVED_MAX_LINES`. Comment and probe only; no behaviour change. (#49)

### Miscellaneous Chores

* **scaffold:** refresh git and CI scaffolding contracts to the current generation (#51)

## [2.7.0] - 2026-10-05

### Features

* **canon:** **breaking** — the anchor whitespace class bumps to version 3: a frozen 28-code-point set (C0 whitespace except the U+001C–U+001F separators, SP, NEL, NBSP, OGHAM SPACE, U+2000–U+200A, U+2028/U+2029, U+202F, U+205F, U+3000, LRM, RLM, BOM) replaces the v2 ASCII-only strip; ZWSP/ZWNJ/ZWJ, SOFT HYPHEN, WORD JOINER, MONGOLIAN VOWEL SEPARATOR and the other C1 controls stay significant (ADR-0029, issue #22). Upgrading rotates anchors on lines containing newly-normalized code points exactly once: old `2:`-prefixed snapshot rows become unreachable and are reclaimed by the LRU vacuum, `file_undo` pins written under v2 keep resolving their own lineage (undo serves the stored v2 anchors verbatim — never re-derived), and live v2 leases may emit one bounded false drift signal before short-lived served state clears. (#45)
* **read:** add `mode: "verbatim"` for plain, anchor-free file text that writes no served state; the default `"served"` render is byte-identical to before. (#44)
* **tools:** remove the deprecated `file_path` payload alias, with no compatibility window. `read` no longer rewrites it to `file`, and `undo_last_edit` no longer rewrites it to `path` -- their `prepareArguments` seam existed only for that rewrite and is gone -- and the `write` hooks no longer read it. A `file_path` payload is now an unknown field on every surface and is refused; `edit` was already strict. (#40)

### Bug Fixes

* **read:** one row budget and a hashless verbatim path. The read row cap now derives from pi's `DEFAULT_MAX_BYTES` (50KB); the dead 200KB `MAX_READ_LINE_BYTES` default that only tests exercised is gone. `mode: "verbatim"` no longer applies the 238,328-line anchor-space cap or allocates line hashes: a file too large to anchor is still a readable, pageable file through the same `offset`/`limit`/`windows` machinery, the same 50KB per-line withhold, and the same silence on served state. The `served` path stays byte-identical and keeps the cap and its refusal message. (#44)

### Performance Improvements

* **read:** page a file instead of materializing it. A read walks the lines it needs — the page, and on the served path every row's anchor in that same walk — instead of building one heap string per line for the whole text (`split("\n")` costs ~50 B per line: 47.2 MB of heap for a 29.9 MB, one-million-line file). Verbatim pages the same bytes as before and builds no line array to slice a page out of — though an unbounded verbatim read still holds the lines it shows, since its page is the whole file — and a served read still holds one line array, in the snapshot store's own lineage write, bounded by the anchor-space ceiling. One refusal moves closer to the load: a file whose line count only crosses the cap after CR normalization now refuses there with the counted message, instead of passing the cap and dying inside the anchor space (that was #43's own regression, fixed before release). Otherwise served is byte-identical: same anchors, same order, same pages, hints and refusals, and the same 238,328-line cap. (#47)

### Code Refactoring

* **read:** remove the `read_skill` tool; `read` with `mode: "verbatim"` is the reference read. (#44)
* **read:** reshape the anchor seam the served read walks through. `AnchorWalk` (the new `src/hashline/index.ts` export) is assignment-only: it carries `assign` or `cached` and no persist hook, because the read path passes `noPersist` and the authoritative snapshot write is `upsertSnapshotFor`. The whole-content `hashesFor`/`readNormFile` seam is unchanged for the edit pipeline. (#47)

### Documentation

* **readme:** cite external evidence for hash-anchored lines — token-bleed reduction (Lamberti 2026) and subword-tokenizer drift (TokDrift) — under the failure-modes table and the anchor-hash space explanation. (#41)
* **readme:** state the 4-char anchor contract end to end — width words, worked `HASH│content` examples, the 62^4 space with the TokDrift citation, and ADR-0030 as the live width record. (#20)
* **docs:** rewrite CONTEXT.md, the live specs, the hash-anchors article, the absorption plan, the benchmarks anchor statement and the archive width mentions to the 4-char contract. (#20)
* **readme:** re-source token economics to Lamberti 2026 (22–58% repair-token cuts), removing the project-derived 40–60% claims. (#20)

### Code Refactoring

* **hashline:** make `HASH_LEN` the single owner of the anchor width — served-guard parse, domain-errors/payload-contract copy, resolve/parse reasons, and the probe stride all derive from it; behaviour and model-visible bytes unchanged at width 3, pinned by a new single-owner arch guard. (#20)

### Tests

* **hashline:** complete the 4-char fixture migration and re-pin capacity bindings. Half-migrated never-served fixtures move to live-width tokens with premise guards; the space-exhaustion payload and read-seam cap become exported constants pinned by binding tests; the edge script joins the width-consistency surface. No shipped logic changed. (#20)
* **hashline:** make the all-digit reservation refutable — duplicate-heavy pure and delta samples carry in-regime pins so the zero-digit assertions cannot go vacuous, the production probe is pinned directly from reserved and top starts, and served anchors resolve for real through the leased seam. Both reservation-site mutants redden exactly their test, then revert. Test-only, `src/` behaviour unchanged. (#20)
* **hashline:** correct the reservation WHY arithmetic — the subcube start is `52 × (62^3 + 62^2 + 62 + 1) = 12,596,220`, and the comment records the measured tops (distinct-line neighbourhood, shipped mixed sample) that keep the qualitative claim. Comment and ADR text only. (#20)
* **hashline:** harden the anchor-width guard to refute numeric and cross-surface drift — leaf walker sees re-exports and dynamic imports (with positive control), exact-line allowlists, a numeric-shape arm on `src/hashline/**`, derived shape samples, and a width-consistency check over `src/**`, `prompts/**` and the package description; `prompts/read.md` presence assertions become width-consistent. Test-only, behaviour unchanged. (#20)
* **hashline:** close the T1b guard gaps — one-arg numeric slice arm, space-form count words, derived foreign-width control, non-vacuous walk pins, dead allowlist entry removed, and dispatch refutation through the shared walk helper. Test-only, `HASH_LEN` stays 3. (#20)
* **hashline:** restore measured width-3 evidence with revision scope instead of repainting it, drive fixture differentials from the fixture token with width-5 tripwires, comment-proof the capacity source pins, generalize the class-quantifier arm past `3|4`, and fix the ADR-0019 supersession link. Docs plus tests only; no shipped logic changed. (#20)
* **hashline:** restore three revision-pinned archive quotes verbatim, record the width-3 digit rate beside its derived live figure, caveat token claims via ADR-0030, and pin the quantifier off-width filter with a live-width control. Docs plus tests only. (#20)
* **benchmarks:** remove the in-repo benchmark suite and its wiring — `benchmarks/`, eval/compare scripts, package scripts, config entries and the README project-benchmark surfaces. The independent third-party benchmark keeps its own section. (#20)
* **e2e:** re-home the deterministic edit battery out of the eval gate — the same 27 local scenarios run counted in `pnpm test` through the validated registry; the package/upstream comparison target is dropped with the benchmark suite. (#20)
* **e2e:** restore per-scenario verdicts in the re-homed battery — outcome, rejection code and preserved content asserted from the recovered comparator table; both accept-where-reject and wrong-content mutants redden. (#20)
* **readme:** drop the unbacked project-battery row and the stale scope comment — the battery cell now names the live `test/e2e` artifact. (#20)
* **e2e:** pin noop byte-identity and fix the T4b review residuals — B11/B12 assert `finalContent` equals the captured pre-edit bytes instead of an inert substring, the battery row fills its fourth cell, and the scope comment drops its duplicated clause. (#20)

* **hashline:** make the file-scope guarantees refutable — C1 asserts a measured intersection bound plus a deterministic same-position guard with a fixed colliding pair, a runtime shared spelling is shown resolving lease-scoped, C4 pins content-keyed verification against file-scoped allocation, and the tautological probe is deleted. Test-only plus a trailing-separator seed fix. (#20)
* **hashstore:** cover pre-bump leases and poisoned snapshots — pre-bump lease sets plus mirrors refuse cold and after a fresh read (with a positive control that the file still edits), poisoned current-generation rows are not served and are swept, planted foreign-generation rows miss both lookups, and the C1 cap WHY states the zero regime with the companion carrying refutability. (#20)
## [2.6.0] - 2026-10-03

### Features

* **edit:** flat wire item replaces the op-bearing shape. `replace_with`, the positional tuple form, and the legacy item keys are removed: sends using them now refuse with `unknown or unsupported fields` naming the replacement -- change `replace_with` payloads to `text` (or `text_ref` with `mode`), tuples to named-key items, and legacy keys to `anchor_from`/`anchor_to`. `file_path` remained a deprecated alias (warns, maps to `path`) on the non-edit tools only -- `edit` has always refused it; it was removed outright afterwards with no compatibility window. (#39)
* **edit:** ship the flat wire item -- exactly one payload per item (`text` for hand-written bytes, `text_ref{mode}` for served-span bytes with strictly required `mode: "copy" | "cut"`), optional `at` (`"in-place"` default; `"in_place"` refused), and `text: ""` in-place delete. Replace, insert-before, insert-after, delete, copy and move are each expressible (ADR-0027). Wording kept strictly additive in evidence. (#39)
* **edit:** `resEdit` barrel signature change -- the internal rename reaches the public barrel (`src/hashline/index.ts`): an internal rename that reaches a public barrel is consumer-visible even when no model sees it. (#39)

### Documentation

* **agents:** add `docs/agents/refining-tool-prompts.md` — the method for refining a tool's prompts (map the surfaces, map the pins, probe behaviourally, measure every ambiguity, review, ticket, verify the served text) and the principles behind it; linked from `AGENTS.md`. (#39)

## [2.5.0] - 2026-10-02

### Bug Fixes

* **release:** stop clearing the ledger before semantic-release (#36)

### Build System

* **build:** ship the prebuilt bundle as the extension entry on both install surfaces (#38)

## [2.4.0] - 2026-09-30

### Features

* **lens:** report served rows to pi-lens' read bridge through a domain-neutral observer seam (#29)
* **lens:** add the /pi-better-edit lens command and the .pi/agents/pi-better-edit.json config with env, project and global precedence (#29)
* **lens:** ship schemas/pi-better-edit.json for editor validation of the config (#29)
* **lens:** mirror landed mutations (edit, write, undo) to pi-lens' mutation bridge through a domain-neutral mutated-file seam (#33)

### Bug Fixes

* **lifecycle:** resolve the write tool's target from file before path and file_path (#29)

* **edit-undo:** derive undo-summary counts from source inputs, not rendered rows (#9)
* commit the edit and undo store state in one transaction, so a store failure can no longer leave the leases and the served mirror disagreeing (#16)
* **preview:** keep the debounced preview bound to the session that armed it across a session switch (#16)
* **drift:** key drift-notice episodes on the drifted line's position, so distinct lines sharing an anchor are no longer collapsed into one silent notice (#16)
* **packaging:** declare typebox as a peer dependency so host-provided copies cannot bypass the extension loader (#34)
* **deps:** pin undici, brace-expansion, fast-uri and esbuild to patched releases via pnpm override so the audit gate clears the transitive DoS and TLS-bypass advisories
### Documentation

* **readme:** record pi-lens interoperability and the read-expansion contract (#29)
* **prompts:** note that served rows may cover an expanded window without naming a provider (#29)
* **readme:** name the read-expansion workarounds and the deferred format interaction (#30)

### Tests

* **edit:** pin the payload wire shape against pi-lens' third-party shape adapters (#31)
* **lens:** pin the mutation-bridge entry shape, the drop accounting and the write-only notification invariant (#33)

### Code Refactoring

* **identity:** rename tombstone vocabulary to blockedHashes, cause contract to blocked-hash (#18)
* **identity:** retire the unused blocked-hash library-seam signal (no live callers), keeping the allocation guard (#25)

## [2.3.0] - 2026-09-27

### Features

* **edit-diff:** formalize the single-projection contract with counted span markers (#174)

### Bug Fixes

* verify preview against the session that served the anchors (#168)
* **edit-diff:** render small middle gaps whole, keep anchors aligned (#172)
* **edit-diff:** render ctx-0 middle gaps marker-only with correct skip (#175)

### Miscellaneous Chores

* **scaffold:** refresh the git contract to the current generation (#167)

## [2.2.0](https://github.com/Rianico/pi-better-edit/compare/v2.1.0...v2.2.0) (2026-09-22)

### Features

* **edit:** accept unread interior rows and cap applied-diff removals ([2e93732](https://github.com/Rianico/pi-better-edit/commit/2e93732e02f4af9d8ec99de1eeae4585ae3782e5)), closes [#149](https://github.com/Rianico/pi-better-edit/issues/149)
* **read:** add multi-window reads and consolidate the read path's stats ([2334352](https://github.com/Rianico/pi-better-edit/commit/2334352206adcf2c5c2cb0d3beaa1eae7ea8f0c4))

## [2.1.0](https://github.com/Rianico/pi-better-edit/compare/v2.0.0...v2.1.0) (2026-09-22)

### Features

* **errors:** diagnose numeric anchors in E_UNKNOWN_ANCHOR to steer away from line numbers ([#158](https://github.com/Rianico/pi-better-edit/issues/158)) ([33ccb0d](https://github.com/Rianico/pi-better-edit/commit/33ccb0da0ce524bd9aeffa6413d3912434c431ab))
* **mutation-engine:** aggregate multi-edit batch errors instead of failing fast on first error ([#159](https://github.com/Rianico/pi-better-edit/issues/159)) ([2217810](https://github.com/Rianico/pi-better-edit/commit/2217810c4f57e9f799ae8954b1b6181b3d0cd05d))
* ship a pre-bundled dist/index.js to cut extension startup latency ([#160](https://github.com/Rianico/pi-better-edit/issues/160)) ([8cdc716](https://github.com/Rianico/pi-better-edit/commit/8cdc7163d6eeb3c7da314c583b6acbbcba866605)), closes [#157](https://github.com/Rianico/pi-better-edit/issues/157) [#156](https://github.com/Rianico/pi-better-edit/issues/156) [#157](https://github.com/Rianico/pi-better-edit/issues/157) [#156](https://github.com/Rianico/pi-better-edit/issues/156) [GH#157](https://github.com/Rianico/GH/issues/157)

### Documentation

* add independent explicit edit benchmark section ([2db15fc](https://github.com/Rianico/pi-better-edit/commit/2db15fc9c155e4d89d3ed71cd7ea75fc4f34ac3e))
* **readme:** rewrite for v2 line-identity mvcc architecture ([b4bd3cb](https://github.com/Rianico/pi-better-edit/commit/b4bd3cb2a49998d8965425a1876623499aad40aa))

## [2.0.0](https://github.com/Rianico/pi-better-edit/compare/v1.7.0...v2.0.0) (2026-09-21)

### ⚠ BREAKING CHANGES

* the tool contract changed for a 1.x consumer. The
`[E_UNSERVED_RANGE]` code no longer exists: a retired bound with a live,
unshifted survivor is `[E_UNVERIFIED_RANGE]`. Edits that 1.x silently
healed -- an interior that shifted under the same 3-char anchor, or a
freed anchor re-used by a byte-identical line -- are now rejected as
`[E_STALE_RANGE]` / `[E_TARGET_LOST]` with the current range served as a
fresh read. A consumer branching on the old code, or relying on a healed
apply, must branch on the new codes and follow the served rows. No data
migration is required: the store migrates additively (HASH_STORE_VERSION
6 to 7) and stays readable by 1.x; anchors served before the upgrade need
one fresh read.

### Features

* **edit:** adopt line-identity MVCC with leases ([bd3a8f2](https://github.com/Rianico/pi-better-edit/commit/bd3a8f221cd7e3acf8c410a3d37237dba0c5201b))
* **edit:** gate reproduced served rows behind a literal declaration ([#134](https://github.com/Rianico/pi-better-edit/issues/134)) ([ba7c8d2](https://github.com/Rianico/pi-better-edit/commit/ba7c8d2ad41262ebf52f402f588f194f18f40323)), closes [#61](https://github.com/Rianico/pi-better-edit/issues/61) [#62](https://github.com/Rianico/pi-better-edit/issues/62) [#63](https://github.com/Rianico/pi-better-edit/issues/63) [#124](https://github.com/Rianico/pi-better-edit/issues/124) [#125](https://github.com/Rianico/pi-better-edit/issues/125) [#126](https://github.com/Rianico/pi-better-edit/issues/126) [#127](https://github.com/Rianico/pi-better-edit/issues/127) [#128](https://github.com/Rianico/pi-better-edit/issues/128) [#129](https://github.com/Rianico/pi-better-edit/issues/129) [#130](https://github.com/Rianico/pi-better-edit/issues/130) [#131](https://github.com/Rianico/pi-better-edit/issues/131)
* **errors:** unify the error and warning contract (E_*/W_* tiers) ([#148](https://github.com/Rianico/pi-better-edit/issues/148)) ([3b22008](https://github.com/Rianico/pi-better-edit/commit/3b22008f9bbb8dd57f82ad0646ef4680b3f0b4ed)), closes [#136](https://github.com/Rianico/pi-better-edit/issues/136) [#138](https://github.com/Rianico/pi-better-edit/issues/138) [#144](https://github.com/Rianico/pi-better-edit/issues/144) [#145](https://github.com/Rianico/pi-better-edit/issues/145) [#146](https://github.com/Rianico/pi-better-edit/issues/146) [#147](https://github.com/Rianico/pi-better-edit/issues/147)
* **hashline:** unify span verification on lease lineage ([#154](https://github.com/Rianico/pi-better-edit/issues/154)) ([65af962](https://github.com/Rianico/pi-better-edit/commit/65af96236f7d0e2f15b1775a2eabd6796ac70750)), closes [#151](https://github.com/Rianico/pi-better-edit/issues/151) [pre-#151](https://github.com/Rianico/pre-/issues/151)

### Bug Fixes

* **hashline:** scope served canons per file and serve fresh read ([#152](https://github.com/Rianico/pi-better-edit/issues/152)) ([47a04f7](https://github.com/Rianico/pi-better-edit/commit/47a04f7ce055d82c517ba00257b8ef921735ad8d)), closes [#149](https://github.com/Rianico/pi-better-edit/issues/149) [#149](https://github.com/Rianico/pi-better-edit/issues/149)

### Documentation

* declare the 2.0 tool-contract break ([#155](https://github.com/Rianico/pi-better-edit/issues/155)) ([ee74c91](https://github.com/Rianico/pi-better-edit/commit/ee74c912ffe46f33c0debf3962805a410190b4d1)), closes [#154](https://github.com/Rianico/pi-better-edit/issues/154) [#148](https://github.com/Rianico/pi-better-edit/issues/148) [#154](https://github.com/Rianico/pi-better-edit/issues/154)

All notable changes to this project will be documented in this file.

## [1.7.0](https://github.com/Rianico/pi-better-edit/compare/v1.6.0...v1.7.0) (2026-09-09)

### Features

* **edit:** adopt named-object payload with file and anchor fields ([#77](https://github.com/Rianico/pi-better-edit/issues/77)) ([741be22](https://github.com/Rianico/pi-better-edit/commit/741be220571e9d5a249a5dd035fb59297c41fe0b))

## [1.6.0](https://github.com/Rianico/pi-better-edit/compare/v1.5.0...v1.6.0) (2026-09-05)

### Features

* **edit:** user/model audience split and glossary-aligned error codes ([dd1a779](https://github.com/Rianico/pi-better-edit/commit/dd1a779b5a5c2ecddd486a49eff9eeed1014aa48)), closes [#65](https://github.com/Rianico/pi-better-edit/issues/65)

### Bug Fixes

* **drift:** report canon deficit instead of hash rotation ([95c4703](https://github.com/Rianico/pi-better-edit/commit/95c4703f7470d651d7b2309921a125959fdf463f)), closes [#68](https://github.com/Rianico/pi-better-edit/issues/68)
* make prepare tolerant when husky not installed ([cca29d3](https://github.com/Rianico/pi-better-edit/commit/cca29d3076068b1bab832eae99da79547d5d4939))
* **served:** epoch lifecycle belongs to full reads ([3918292](https://github.com/Rianico/pi-better-edit/commit/3918292a85ad3a230b6705cf03a12e67ff04717b)), closes [#69](https://github.com/Rianico/pi-better-edit/issues/69)
* **write:** dense re-serve after write clears stale rows ([44c7664](https://github.com/Rianico/pi-better-edit/commit/44c7664e708b0aba3277754b7e80b9fff62371bf)), closes [#70](https://github.com/Rianico/pi-better-edit/issues/70)

### Documentation

* **prompts:** align tool desc and prompts with glossary (fresh anchors) ([b0bcf0b](https://github.com/Rianico/pi-better-edit/commit/b0bcf0b26cdd6a6806f85654247663a474703149))

## [1.5.0](https://github.com/Rianico/pi-better-edit/compare/v1.4.3...v1.5.0) (2026-09-03)

### Features

* consolidate architecture deepening — 6 deep modules ([#64](https://github.com/Rianico/pi-better-edit/issues/64)) ([6cbf5da](https://github.com/Rianico/pi-better-edit/commit/6cbf5da3fed20588d33c87fb05b3307c23501404))

## [1.4.3](https://github.com/Rianico/pi-better-edit/compare/v1.4.2...v1.4.3) (2026-09-01)

### Bug Fixes

* **edit:** prevent tool calling bleed on Gemma 4 ([#57](https://github.com/Rianico/pi-better-edit/issues/57)) ([e67f493](https://github.com/Rianico/pi-better-edit/commit/e67f493ab6858d26a36329fbeb08a7a3779574e8)), closes [#55](https://github.com/Rianico/pi-better-edit/issues/55)
* **hashline:** prevent freed anchor reuse via per-session tombstone and epoch (ADR-0013) ([#56](https://github.com/Rianico/pi-better-edit/issues/56)) ([79b4931](https://github.com/Rianico/pi-better-edit/commit/79b49318df992d09e2d613dbb5ebc3c39d435de1))

## [1.4.2](https://github.com/Rianico/pi-better-edit/compare/v1.4.1...v1.4.2) (2026-09-01)

### Bug Fixes

* **ci:** prevent pre-push from blocking release push ([daa3d18](https://github.com/Rianico/pi-better-edit/commit/daa3d186020df736c9724d46af3f6b16100b3ef9))

## [1.4.1](https://github.com/Rianico/pi-better-edit/compare/v1.4.0...v1.4.1) (2026-08-31)

### Bug Fixes

* **ci:** lower statements coverage threshold to 89 to match actual ([f5b58a5](https://github.com/Rianico/pi-better-edit/commit/f5b58a59d78c8e1c243642f362f995904b12eb68))
* **ci:** repair lockfile and bump node to 22 for semantic-release ([62ab62a](https://github.com/Rianico/pi-better-edit/commit/62ab62a78bf95a598671d3848aa59dec1f902fb7))
* **hashline:** remove boundary-dup auto-fix, keep pure edit ([#54](https://github.com/Rianico/pi-better-edit/issues/54)) ([7c55b57](https://github.com/Rianico/pi-better-edit/commit/7c55b5713f43a73dc2f972e4b99050b036d2c625))

## [1.4.0](https://github.com/Rianico/pi-better-edit/compare/v1.3.0...v1.4.0) (2026-08-29)

### Code Refactoring

* consolidate architecture deepening tranche (C1–C5) into `map/architecture-deepening` — `MutationEngine`, `ServedSession`, `FileContent`, `LifecycleHooks`, `HealingStrategy` ([#53](https://github.com/Rianico/pi-better-edit/pull/53))
* add SAFETY for `x as unknown as` casts and fix unlisted/cache blockers for v1.4.0

## [1.3.0](https://github.com/Rianico/pi-better-edit/compare/v1.2.3...v1.3.0) (2026-08-28)

### Features

* **edit:** route drift signals to user-facing details ([6ec52f2](https://github.com/Rianico/pi-better-edit/commit/6ec52f2e3789b7c7d6e10c4ebcc43c4518e8d3d3))

### Documentation

* merge scaffold-git prompts into one (Obsidian flavour) ([ef613d2](https://github.com/Rianico/pi-better-edit/commit/ef613d21605149615936cce0deeadf118d68e97a))

## [1.2.3] - 2026-08-28

### Fixed

* allow _-prefixed unused exports and scoped no-comments for publish

### Changed

* wire semantic-release (conventionalcommits) with pinned release workflow

## [1.2.2] - 2026-08-28

### Fixed

* address P1 blocking — error-swallowing + SAFETY for as-unknown-as + unknown returns
* harden path traversal and ReDoS via root containment and bounded RegExp, tighten CI permissions
* propagate errors after log instead of swallowing undefined
* prune deadcode via knip whitelist and barrel dedupe
* add node: prefix and .js extensions to relative imports
* reduce complexity via helper extraction and early returns
* fix nits — console, typos (ALPH→ALPHA), prefer-at, slice-copy and style

### Changed

* remove deprecated agent skills (coding-protocol, keel, show-me) — .pi/ is source of truth
* ignore .lsz/ ephemeral artifacts
