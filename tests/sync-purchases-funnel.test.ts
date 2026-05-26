// Phase 3.5 contract tests — manual syncPurchases() emits a
// purchase.completed event so the funnel reconciles with the
// Swift/Android auto-track path.
//
// Pre-v1.4.0 Web/Node/RN manual syncPurchases emitted ZERO
// analytics — only a debug signal. Dashboards saw revenue lift
// from auto-track paths but not from the explicit "I just bought
// something on the web" flow, breaking conversion funnels.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossdeckClient } from "../src/crossdeck";
import { MemoryStorage } from "../src/storage";

describe("syncPurchases() funnel parity (Phase 3.5)", () => {
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

  it("emits purchase.completed after a successful sync", async () => {
    // Capture every fetch call so we can find the analytics POST
    // that fires AFTER the syncPurchases response.
    const calls: { url: string; body: unknown }[] = [];
    const fetchSpy = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      const parsedBody = init.body ? JSON.parse(init.body as string) : null;
      calls.push({ url, body: parsedBody });

      if (url.includes("/purchases/sync")) {
        return Promise.resolve(jsonResponse({
          object: "purchase_result",
          crossdeckCustomerId: "cdcust_test",
          env: "production",
          entitlements: [
            {
              object: "entitlement",
              key: "pro",
              isActive: true,
              validUntil: null,
              source: { rail: "apple", productId: "com.app.pro_monthly", subscriptionId: "sub_xyz" },
              updatedAt: 1_700_000_000,
            },
          ],
        }));
      }
      // /events ingest endpoint
      return Promise.resolve(jsonResponse({ object: "list", received: 1, env: "production" }, 202));
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const c = new CrossdeckClient();
    c.init({
      appId: "app_test_funnel",
      publicKey: "cd_pub_test_funnel",
      environment: "sandbox",
      storage: new MemoryStorage(),
      autoHeartbeat: false,
    });

    await c.syncPurchases({ rail: "apple", signedTransactionInfo: "eyJ.jws.sig" });
    await c.flush();

    // Find the analytics POST that carries the purchase.completed.
    const eventCalls = calls.filter((c) => c.url.includes("/events"));
    expect(eventCalls.length).toBeGreaterThan(0);

    const events = eventCalls.flatMap((c) => (c.body as { events?: unknown[] })?.events ?? []);
    const purchaseCompleted = events.find(
      (e): e is { name: string; properties: Record<string, unknown> } =>
        typeof e === "object" && e !== null && (e as { name?: unknown }).name === "purchase.completed",
    );
    expect(purchaseCompleted).toBeDefined();
    expect(purchaseCompleted?.properties.rail).toBe("apple");
    expect(purchaseCompleted?.properties.productId).toBe("com.app.pro_monthly");
    expect(purchaseCompleted?.properties.subscriptionId).toBe("sub_xyz");
  });

  it("carries idempotent_replay=true when backend replied from cache", async () => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init: RequestInit) => {
      const parsedBody = init.body ? JSON.parse(init.body as string) : null;
      calls.push({ url, body: parsedBody });
      if (url.includes("/purchases/sync")) {
        return Promise.resolve(jsonResponse({
          object: "purchase_result",
          crossdeckCustomerId: "cdcust_test",
          env: "production",
          entitlements: [
            {
              object: "entitlement",
              key: "pro",
              isActive: true,
              validUntil: null,
              source: { rail: "apple", productId: "p1", subscriptionId: "s1" },
              updatedAt: 1_700_000_000,
            },
          ],
          idempotent_replay: true,
        }));
      }
      return Promise.resolve(jsonResponse({ object: "list", received: 1, env: "production" }, 202));
    }) as unknown as typeof fetch;

    const c = new CrossdeckClient();
    c.init({
      appId: "app_test_replay",
      publicKey: "cd_pub_test_replay",
      environment: "sandbox",
      storage: new MemoryStorage(),
      autoHeartbeat: false,
    });

    await c.syncPurchases({ rail: "apple", signedTransactionInfo: "eyJ.jws.sig" });
    await c.flush();

    const events = calls
      .filter((c) => c.url.includes("/events"))
      .flatMap((c) => (c.body as { events?: unknown[] })?.events ?? []);
    const purchaseCompleted = events.find(
      (e): e is { name: string; properties: Record<string, unknown> } =>
        typeof e === "object" && e !== null && (e as { name?: unknown }).name === "purchase.completed",
    );
    expect(purchaseCompleted?.properties.idempotent_replay).toBe(true);
  });
});
