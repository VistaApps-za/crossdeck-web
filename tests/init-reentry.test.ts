// Phase 5.5 contract tests — init() re-entry must drain the prior
// EventQueue's pending timer BEFORE replacing this.state.
//
// Pre-v1.4.0 the teardown handled autoTracker / webVitals / errors
// / unloadFlush but NOT events. The prior queue's setTimeout
// would fire AFTER the state swap, sending old-init events against
// new-init http / identity — a cross-identity leak during HMR /
// config swap / multi-tenant SDK shells.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossdeckClient } from "../src/crossdeck";
import type { KeyValueStorage } from "../src/types";

/** Test-only storage that exposes its underlying map so assertions
 * can inspect what the SDK persisted across init() re-entries. */
class InspectableStorage implements KeyValueStorage {
  public data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe("init() re-entry (Phase 5.5)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("re-init drains the prior queue's pending timer before swapping state", async () => {
    const sent: string[] = [];
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      sent.push(url);
      return Promise.resolve(jsonResponse({ object: "list", received: 1, env: "production" }, 202));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = new CrossdeckClient();
    c.init({
      appId: "app_first",
      publicKey: "cd_pub_test_first",
      environment: "sandbox",
      storage: new InspectableStorage(),
      autoHeartbeat: false,
    });

    // Buffer an event under the FIRST init's identity — would
    // normally drain on the queue's setTimeout interval.
    c.track("event.under_first_init", { a: 1 });

    const callsBeforeReinit = fetchSpy.mock.calls.length;

    // Re-init: SHOULD trigger a synchronous flush of the prior
    // queue before this.state is replaced.
    c.init({
      appId: "app_second",
      publicKey: "cd_pub_test_second",
      environment: "sandbox",
      storage: new InspectableStorage(),
      autoHeartbeat: false,
    });

    // Allow microtask drain so the flush completes.
    await new Promise((r) => setTimeout(r, 10));

    const callsAfterReinit = fetchSpy.mock.calls.length;
    expect(callsAfterReinit).toBeGreaterThan(callsBeforeReinit);
  });

  it("re-init does NOT wipe the durable event store", async () => {
    // The persistent queue belongs to the SDK lifetime, not the
    // init() lifetime — a crash mid-flush re-hydrates on the next
    // init. Wiping it on re-init would lose that guarantee.
    const storage = new InspectableStorage();
    globalThis.fetch = vi.fn().mockImplementation(() => {
      // Simulate offline: 503 so events stay buffered.
      return Promise.resolve(jsonResponse({}, 503));
    }) as unknown as typeof fetch;

    const c = new CrossdeckClient();
    c.init({
      appId: "app_first",
      publicKey: "cd_pub_test_first",
      environment: "sandbox",
      storage,
      autoHeartbeat: false,
    });
    c.track("event.would_persist", { x: 1 });
    await new Promise((r) => setTimeout(r, 5));

    const queueKeysBeforeReinit = [...storage.data.keys()].filter((k) =>
      k.includes("queue") || k.includes("events"),
    );

    c.init({
      appId: "app_second",
      publicKey: "cd_pub_test_second",
      environment: "sandbox",
      storage,
      autoHeartbeat: false,
    });
    await new Promise((r) => setTimeout(r, 10));

    const queueKeysAfterReinit = [...storage.data.keys()].filter((k) =>
      k.includes("queue") || k.includes("events"),
    );

    // Bank-grade invariant: durable queue persistence is preserved
    // across re-init. The teardown must not call
    // persistent.clear() — only flush() + cancelTimerIfSet().
    expect(queueKeysAfterReinit.length).toBeGreaterThanOrEqual(
      queueKeysBeforeReinit.length,
    );
  });
});
