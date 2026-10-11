/**
 * #90 — the janitor's trigger: the two lifecycle events that are OFF the tool-call hot path.
 *
 * WHY this file exists: a background timer is impossible (the extension API exposes no idle timer and
 * no `deactivate` event), so the only honest trigger is a lifecycle event, and the choice of WHICH
 * event is load-bearing — a janitor run on `tool_call`/`tool_result` would be paid by every tool call
 * and could hold the write lock the call is waiting on. These tests pin the wiring: exactly
 * `session_start` and `session_shutdown` are subscribed, each one runs the janitor, and no hot-path
 * event is subscribed at all.
 */
import { describe, expect, it, vi } from "vitest";

import { JANITOR_EVENTS, registerJanitorHooks } from "../../src/store-janitor";
import type { JanitorOutcome } from "../../src/store-janitor";

const RUN: JanitorOutcome = {
  ran: true,
  deleted: { snapshots: 0, lineage: 0, leases: 0, expiredLeases: 0 },
  deepCheckFailed: false,
  rebuilt: false,
};

/** The event names the extension API exposes that a maintenance pass must never ride on. */
const HOT_PATH_EVENTS = [
  "tool_call",
  "tool_result",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "context",
  "before_provider_request",
];

/** A stand-in for `pi` that records what was subscribed and hands the handlers back. */
function fakePi(): {
  readonly subscriptions: Array<{ event: string; handler: () => Promise<void> }>;
  readonly pi: unknown;
} {
  const subscriptions: Array<{ event: string; handler: () => Promise<void> }> = [];
  return {
    subscriptions,
    pi: {
      on(event: string, handler: () => Promise<void>) {
        subscriptions.push({ event, handler });
      },
    },
  };
}

describe("the janitor's lifecycle wiring", () => {
  it("subscribes session_start and session_shutdown, and no other event", () => {
    const { pi, subscriptions } = fakePi();
    registerJanitorHooks(pi as never, { runJanitor: async () => RUN });

    expect(subscriptions.map((entry) => entry.event)).toEqual([...JANITOR_EVENTS]);
    for (const forbidden of HOT_PATH_EVENTS) {
      expect(subscriptions.some((entry) => entry.event === forbidden)).toBe(false);
    }
  });

  it("runs the janitor on each subscribed event", async () => {
    const { pi, subscriptions } = fakePi();
    const run = vi.fn(async () => RUN);
    registerJanitorHooks(pi as never, { runJanitor: run });

    for (const { handler } of subscriptions) await handler();

    expect(run).toHaveBeenCalledTimes(subscriptions.length);
    expect(subscriptions.length).toBeGreaterThan(0);
  });

  it("swallows a failing pass so maintenance never breaks the session", async () => {
    const { pi, subscriptions } = fakePi();
    const run = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    registerJanitorHooks(pi as never, { runJanitor: run });
    try {
      await expect(subscriptions[0]?.handler()).resolves.toBeUndefined();
      expect(reported).toHaveBeenCalled();
    } finally {
      reported.mockRestore();
    }
  });
});
