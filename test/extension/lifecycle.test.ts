import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { loadHashStore, type HashStore } from "../../src/hash-store";
import { upsertServed, getServed } from "../../src/served-session/index.js";
import { upsertSnapshot, getSnapshot, snapshotHashFor } from "../../src/snapshot-store";
import { withTempDir } from "../support/fixtures";

/**
 * WHY a per-event LIST and not a `Map<event, handler>`: the extension API ACCUMULATES registrations,
 * so a second `pi.on("session_start", …)` ADDS a handler rather than replacing one. Measured, not
 * assumed — `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js` implements
 * `on(event, handler)` as `const list = extension.handlers.get(event) ?? []; list.push(handler);
 * extension.handlers.set(event, list)`, and `runner.js` dispatches one event by looping
 * `for (const handler of handlers)` (its own comment: "A single extension may register multiple
 * handlers for the same event"). A probe against that loader and runner registered two
 * `session_start` handlers and both ran.
 *
 * WHY it is load-bearing HERE: the entry point registers THREE `session_start` handlers — #165's
 * session capture inside `regEdit`, the lifecycle hook's session-start work, and (since #90) the
 * store janitor's pass. The last-write-wins `Map` this helper used to hold let the janitor's
 * registration SHADOW the handler under test, so the notify assertion below read zero calls against
 * a host that calls every handler. Collapsing registrations is not a simplification; keep the list.
 */
function makeLifecyclePi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const notify = vi.fn();
  let activeTools: string[] = [];
  const pi = {
    registerTool() {},
    registerCommand(name: string, def: { handler: (...args: unknown[]) => unknown }) {
      commands.set(name, def);
    },
    // WHY: `loader.js`'s `on`, in effect — append to the event's list, never replace it.
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getActiveTools: () => activeTools,
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
  } as any;
  /**
   * Dispatch `event` the way the host does (`runner.js`'s `emit`): EVERY handler registered for it,
   * in registration order. Driving one handler lifted out of the map would re-open the exact
   * fidelity gap this harness was fixed for.
   *
   * WHY the throws are collected and re-raised instead of swallowed: the host keeps one bad handler
   * from cancelling its siblings (it runs the rest, then reports through `emitError`), so the loop
   * must finish — but a handler that throws is a broken extension, so the failure must still reach
   * the test rather than vanish behind a silently-absent side effect.
   *
   * WHAT THIS DOUBLE MODELS AND WHAT IT DELIBERATELY DOES NOT. Each divergence is labelled, because
   * a stub STRICTER than the host is safe while a stub LAXER is how a green test hides a production
   * miss.
   *
   * DIVERGENCE — the `registered.length === 0` throw in this helper is STRICTER than the host, the
   * safe direction. The host tolerates an unsubscribed event: `runner.js`'s `ExtensionRunner.emit`
   * reads each extension's handler list for the event and `continue`s when it is absent or empty,
   * returning without complaint, and it CATCHES a handler's throw and reports it through `emitError`
   * before the next handler runs — so the host neither throws for an unsubscribed event nor lets a
   * handler throw end the emit. The host's own `emitSessionShutdownEvent` guards its call with
   * `hasHandlers("session_shutdown")`, a check that is only necessary BECAUSE the emit path tolerates
   * zero handlers. Throwing is therefore OUR anti-vacuity device, not a host behaviour, and it cannot
   * hide a production miss: a stricter double produces false REDs, and only a false GREEN can bury a
   * miss — the collected-and-re-raised handler throws above are the same safe direction.
   *
   * BOUNDARY, unmodelled — `result.cancel`. For the cancelable BEFORE-events (`isSessionBeforeEvent`:
   * `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_before_tree`)
   * the host's `emit` keeps a handler's RETURNED value and returns at once when it carries a cancel
   * flag, so later subscribers never run. This double ignores return values. A case asserting that a
   * cancelled BEFORE-event stopped the dispatch would therefore read no effect where the host reads
   * one — LAXER than the host in exactly the dimension that case asserts. Latent, not benign: safe
   * only while NO case exercises it, so extend this double BEFORE adding one.
   *
   * BOUNDARY, unmodelled — cross-extension ordering. The host's `emit` nests extension-load order
   * OUTER around registration order INNER (`for (const ext of this.extensions)` wrapping
   * `for (const handler of handlers)`), so two extensions interleave event by event. This harness
   * registers one extension's handlers into one flat per-event list and orders them only by
   * registration, so it cannot express an interleaving across extensions. Same scope rule as above:
   * safe while no case asserts an order between two extensions, LAXER the instant one does.
   *
   * WHY THE SCOPE IS WRITTEN DOWN: each bound above names the symbol whose reading produced it, so a
   * later editor can re-measure instead of guessing. An unexplained hedge is the first thing a
   * well-meaning editor deletes — they cannot tell whether it was measured, guessed or copied — and
   * they simplify it back to the unconditional sentence, which is the false one.
   */
  const emit = async (event: string, ...args: unknown[]): Promise<void> => {
    const registered = handlers.get(event) ?? [];
    // WHY: emitting an event nothing subscribed to would let every assertion below pass vacuously.
    if (registered.length === 0) throw new Error(`no handler registered for "${event}"`);
    const failures: unknown[] = [];
    for (const handler of registered) {
      try {
        await handler(...args);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `handlers for "${event}" threw`);
  };
  return { pi, handlers, commands, notify, getActiveTools: () => activeTools, emit };
}

/**
 * The POSITIVE CONTROL for the cases below whose subject is an ABSENCE.
 *
 * WHY a control at all: `notify` never called, the active tool set unchanged, and served state
 * intact are all satisfied by a hook that never runs, so each of those cases must first PROVE the
 * session-start work executed. Measured on this file: with the lifecycle hook's `session_start`
 * registration removed from the entry point, it reported `1 failed | 3 passed` — only the debug
 * case, whose assertion is positive, noticed.
 *
 * WHY the double's anti-vacuity throw is not that proof: it guards the whole EVENT (no handler
 * registered for `event` at all), not one handler, and the janitor keeps `session_start` registered
 * (`JANITOR_EVENTS`), so it cannot fire in the mutant that matters here. A guard that only reports
 * "everyone is missing" cannot report "the handler under test ran".
 *
 * WHY the observable is this prune: the one effect `onSessionStart` has besides the debug notify is
 * `deps.pruneMissingAll`, which drops the snapshots of files that no longer exist. No other
 * `session_start` subscriber in the entry point produces it — `regEdit`'s #165 capture only records
 * the ctx's session manager, and the janitor deletes foreign-generation and expired rows, never a
 * missing-file snapshot — so "the seeded snapshot is gone" is caused by the hook under test.
 *
 * WHY the seed is asserted PRESENT before the emit: the control claims a disappearance, and a
 * disappearance only evidences work if there was something to disappear; an unarmed absence would
 * be the same vacuous assertion this control exists to remove.
 */
interface SessionStartControl {
  readonly store: HashStore;
  readonly path: string;
  readonly content: string;
}

async function armSessionStartControl(dir: string): Promise<SessionStartControl> {
  const store = await loadHashStore();
  // WHY never written: a snapshot whose file is gone is exactly what `pruneMissing` exists to drop.
  const path = join(dir, "stale-never-written.ts");
  const content = "stale\n";
  upsertSnapshot(store, {
    path,
    snapshotHash: snapshotHashFor(content),
    lineCount: 1,
    hashes: ["abcc"],
    content,
  });
  expect(getSnapshot(store, path, content)).toEqual(["abcc"]);
  return { store, path, content };
}

/** The control itself: the hook under test ran iff it pruned the armed snapshot. */
function expectSessionStartWorkRan(control: SessionStartControl): void {
  expect(getSnapshot(control.store, control.path, control.content)).toBeUndefined();
}

async function registerExtension(pi: any) {
  const { default: register } = await import("../../index");
  register(pi);
}

describe("session_start lifecycle", () => {
  it("leaves the active tool set untouched (the extension owns the edit name)", async () => {
    await withTempDir("lifecycle-tools-", async (dir) => {
      const { pi, emit } = makeLifecyclePi();
      pi.setActiveTools(["read", "edit", "write", "bash"]);
      await registerExtension(pi);
      const control = await armSessionStartControl(dir);
      // WHY: the whole event, as the host emits it — three handlers subscribe to `session_start`.
      await emit("session_start", {}, { cwd: dir, ui: { notify: vi.fn() } });
      expectSessionStartWorkRan(control);
      expect(pi.getActiveTools()).toEqual(["read", "edit", "write", "bash"]);
    });
  });

  it("notifies when PI_HASHLINE_DEBUG is enabled", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "1");
    try {
      await withTempDir("lifecycle-debug-", async (dir) => {
        const { pi, notify, emit } = makeLifecyclePi();
        await registerExtension(pi);
        await emit("session_start", {}, { cwd: dir, ui: { notify } });
        expect(notify).toHaveBeenCalledWith("Hashline Edit mode active", "info");
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stays silent without PI_HASHLINE_DEBUG", async () => {
    vi.stubEnv("PI_HASHLINE_DEBUG", "0");
    try {
      await withTempDir("lifecycle-quiet-", async (dir) => {
        const { pi, notify, emit } = makeLifecyclePi();
        await registerExtension(pi);
        const control = await armSessionStartControl(dir);
        await emit("session_start", {}, { cwd: dir, ui: { notify } });
        expectSessionStartWorkRan(control);
        expect(notify).not.toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps served state at session start", async () => {
    await withTempDir("lifecycle-served-", async (dir) => {
      const { writeFile } = await import("fs/promises");
      const keep = join(dir, "keep.ts");
      await writeFile(keep, "keep\n", "utf-8");

      const store = await loadHashStore();
      upsertServed(store, "sessionA", keep, [{ position: 0, hash: "abcc" }]);
      upsertSnapshot(store, {
        path: keep,
        snapshotHash: snapshotHashFor("keep\n"),
        lineCount: 1,
        hashes: ["abcc"],
        content: "keep\n",
      });

      const { pi, emit } = makeLifecyclePi();
      await registerExtension(pi);
      const control = await armSessionStartControl(dir);
      await emit("session_start", {}, { cwd: dir, ui: { notify: vi.fn() } });

      expectSessionStartWorkRan(control);
      expect(getServed(store, "sessionA", keep)).toEqual(["abcc"]);
      expect(getSnapshot(store, keep, "keep\n")).toEqual(["abcc"]);
    });
  });
});
