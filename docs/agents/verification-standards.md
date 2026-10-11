# Verification Standards

How this repo decides whether a check is worth anything. Every rule below carries the evidence that established
it, because a rule without its reason becomes folklore the first time it is inconvenient.

The spine: **a check corroborates only if it can fail for the reason it exists.** Its corollary is why this file
exists — *a check that cannot fail for the reason it exists is worse than no check*: no check leaves a gap someone
notices, a check that cannot fail leaves a number someone trusts. The five instances below are that one
requirement seen from five sides, each with a #90 worked example and its **enforcement site**.

## 1 · Checks

### (a) Independence of knowledge

A second measurement must not **know** the first. Pre-register the prediction — the expected reconciliation, the
rung you expect to fire — *before* you measure, because **a reconciliation found after a disagreement is
indistinguishable from a rationalisation, while one written before is a hypothesis with a test.**

> **Honest accounting, from #90.** The tranche pre-registered a reconciliation ladder that never fired: zero
> divergences, so its measured return was zero. What it did return was the artifacts the protocol forced —
> symbol-only citations, checkable phrasing, a bound beside its reason. A pre-registered rung that never fires is
> a cost whose measured return was zero, and saying so is part of the rule.

**Enforcement: convention.** Nothing in the tree can observe the order of a prediction and its measurement.

### (b) Independence of instrument

A second measurement must not read through the same **layer**: two runs of the same command through the same
renderer agree perfectly and prove nothing. The routes that differ in the layer where an artifact can enter:

| route | second route | the artifact that separates them |
|---|---|---|
| rendered `git diff` output | the bytes git writes | a `Changes:` trailer appended by the output layer |
| porcelain `git diff --name-only` | plumbing `git diff-tree -r --name-only --no-commit-id` | the same trailer |
| a text filter over a rendered diff | `git diff --numstat` | 91 vs 94 added lines |
| reading the ignore rule | `git check-ignore`, `git status --untracked-files=all` | a symlinked path |

> **Measured at `8c2504a`.** `git diff --name-only 733003b..8c2504a` redirected through the wrapped `git` wrote 589
> bytes ending `\nChanges:\n`; piped, or run from the absolute binary path, it wrote 578. Counting added lines in
> `d13a2f6..b95f7b7` by `grep -c '^+[^+]'` gives 91, `git diff --numstat` gives 94 — the gap is the three added
> blank lines the pattern cannot see. `.gitignore`'s `node_modules/` is a directory-only pattern: it matches the
> real directory and `git check-ignore` exits 1 on a symlink named `node_modules`, which `git status` reports untracked.

The preventive form is **structural**: routes that differ **by construction** — in the write path, the formatting
path, or the oracle — not two commands that happen to be different. *"Would the routes diverge if the artifact
were present?"* is the **diagnostic**, askable only after the fact: while the instrument is wrong you cannot know
where the artifact lives, which is why the remedy is to choose the routes structurally rather than reason later.

**Enforcement: mixed.** The tree-residue half is mechanised as [CONTRIBUTING.md](../../CONTRIBUTING.md)'s two scans
— the repo-wide `find . -path ./node_modules -prune -o -name '*-probe*' -print` and the tracked-vs-untracked
comparison `comm -13 <(git ls-files '*.test.ts' | sort) <(find . -path ./node_modules -prune -o -name '*.test.ts' -print | sed 's|^\./||' | sort)`
— which disagree with `git status` exactly when the residue is gitignored. The route choice is otherwise **convention**.

### (c) Identity over count

A count must be able to be wrong in the way that matters. `4 failed` is not evidence; **which four, and at which
assertion** is.

> **The mutation whose target was `4 failed`.** Deregistering the lifecycle hook's `session_start` registration
> reddens `test/extension/lifecycle.test.ts` at three cases through the shared antecedent control
> (`expectSessionStartWorkRan`) and one through its positive assertion (the `notify` case), with zero extras — and
> the arming assertion in `armSessionStartControl` (`expect(getSnapshot(...)).toEqual(["abcc"])`) **passes**, which
> is what makes each failure the missing antecedent rather than collateral.

Two smaller instances: the flake protocol's *"same two tests every time"* (a deterministic failure is not a flake,
and re-running does not make it one), and the per-sha table's *"every delta accounted for"* (a test-only commit
moves the count by zero, and the table states that rather than leaving it to be inferred).

**Enforcement: convention.** The identities live in the report; no artifact holds them.

### (d) Mutation as acceptance

A test-strength fix is proved by a mutation, not by an argument. Where the change under review *is* a test, the
mutation **is** the review — no second adversarial pass is owed.

> **Two probes, not one.** Removing the registration reddens four cases; removing the handler's **own work** (the
> prune the control observes) reddens exactly the three controlled cases and leaves the positive case green. The
> second probe is what shows the control tracks the hook rather than the event's arity.

**Enforcement: convention**, over the named test the mutation must redden (`test/extension/lifecycle.test.ts`).

### (e) Tip-binding

A green must be able to fail for the reason it exists — **that the tree moved**. Bind every result to
`git rev-parse HEAD` and to the tracked-tree fingerprint, `git diff-index --quiet HEAD` (exit 0 = no tracked path
differs from `HEAD`, staged or unstaged).

This one is in the list because it fails by **false attestation** rather than by a wrong number: a stale green is
not caught by the next measurement, it is *quoted* by the next reader.

**Enforcement: mechanised.** [CONTRIBUTING.md](../../CONTRIBUTING.md)'s *Gate preconditions* names the sha, both
empty-tree checks, `git diff-index --quiet HEAD`, an empty `git stash list`, and `uptime`. Push state is
`git ls-remote --heads origin <branch>` (empty = no remote ref).

## 2 · Claims

- **Reach ≤ competence.** Claim only what your artifact can see.
- **Scope + direction + safety argument.** Each part answers a different failure: the scope stops silent decay, the
  direction says which way the risk runs, the safety argument makes the divergence defensible rather than convenient.
- **A bound beside the reason it exists** — a limit with no reason beside it is the first thing an editor deletes.
- **Measure before briefing.** A figure you did not take is a figure someone else will quote.
- **Label a hypothesis as a hypothesis** in the text, not only in your head.
- **An inherited claim is an unmeasured claim.** The #90 report forwarded a child's `Changes:` attribution as a
  measured environment finding, and a two-minute probe refuted both halves of it.

**Enforcement: mixed.** The comment gate — `harness/no-comments`, an oxlint jsPlugin configured in
`.oxlintrc.json` — forces every non-JSDoc comment to carry an allowlisted tag (`WHY:`, `SAFETY:`, `Invariant:`,
`See ADR-`), so the *reason* has a place to live; the *content* is **convention**.

## 3 · Decay

A claim must hold at the point a reader actually reads it, not only at the point it was written.

| | cannot rot | can rot |
|---|---|---|
| **true when written** | safe | bind it — a symbol, a sha |
| **false when written** | correct it | correct it **and** bind it |

The fourth cell needs the **union** of both remedies, and #90 has the instance:

> `src/store-janitor.ts`'s module header placed the #90/#100 boundary "where the deep check is scheduled" — a
> **location claim** (false: the deep check is scheduled in `runJanitor`, far from the header owning the clause text)
> that could also **rot** (the scheduling site can move). The fix re-pointed at the module's own behaviour and
> dropped the location claim — both remedies, one edit. (Pre-fix wording at `5736d71^` on `origin/feat/90-store-janitor-gc`.)

**Order by invisibility to review, not by severity.** Review is a **writing-time** instrument; decay fails at
**reading** time. That is why every decay instance in this tranche survived review.

**The preventive form: bind the thing that can move.** A **symbol** rather than a line range for a dependency; a
**sha** rather than "the tip"; a **reason** beside a bound; a **superseding commit** rather than silence.

**Enforcement: convention.** The mechanised analogue is ADR numbering — `test/arch/adr-numbering.test.ts` pins
heading/filename agreement, so a renumbering cannot silently rot ([docs/agents/domain.md](domain.md)).

## 4 · Pricing

Enumerate the **obligation set** before pricing it: a cost model is a claim about the future, and the obligations
are the only part you can actually count.

Batch by **invalidation**, not by discovery. A gate is superseded by **any** commit, so the cost is per
**tip-opening event** and the lever is how many times you open one — not how many findings you collected. Two
groups land before one gate, not one gate per group.

**Enforcement: convention.**

## The commands this repo's gate actually uses

`pnpm run lint` (oxlint + `knip --max-issues`) · `pnpm run format` (oxfmt `--check`) · `pnpm run typecheck` (tsc
`--noEmit`) · `pnpm run test:coverage` (vitest + thresholds) · `uv run python scripts/changelog-gate.py ledger
--landing squash` · the two residue scans and `git diff-index --quiet HEAD` above · `git ls-remote --heads origin <branch>`.
