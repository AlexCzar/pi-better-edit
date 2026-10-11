import { describe, expect, it, vi } from "vitest";
import { loadHashStore } from "../../src/hash-store";
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
      // WHY: the whole event, as the host emits it — three handlers subscribe to `session_start`.
      await emit("session_start", {}, { cwd: dir, ui: { notify: vi.fn() } });
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
        await emit("session_start", {}, { cwd: dir, ui: { notify } });
        expect(notify).not.toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps served state at session start", async () => {
    await withTempDir("lifecycle-served-", async (dir) => {
      const { writeFile } = await import("fs/promises");
      const { join } = await import("path");
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
      await emit("session_start", {}, { cwd: dir, ui: { notify: vi.fn() } });

      expect(getServed(store, "sessionA", keep)).toEqual(["abcc"]);
      expect(getSnapshot(store, keep, "keep\n")).toEqual(["abcc"]);
    });
  });
});
