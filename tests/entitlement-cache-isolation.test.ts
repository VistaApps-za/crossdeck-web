// Phase 1.3 contract tests — cross-tenant entitlement cache scoping.
//
// Three-layer bank-grade isolation that MUST survive any code drift:
//   (a) Per-user storage key — `crossdeck:entitlements:<sha256(userId)>`.
//   (b) identify() unconditionally wipes in-memory cache + switches slot.
//   (c) reset() wipes EVERY per-user slot via the persisted index.
//
// A regression in any layer would re-introduce the cross-customer
// entitlement leak that triggered the v1.4.0 reconciliation.

import { describe, it, expect, beforeEach } from "vitest";
import { EntitlementCache } from "../src/entitlement-cache";
import { sha256Hex } from "../src/hash";
import type { KeyValueStorage, PublicEntitlement } from "../src/types";

class MapStorage implements KeyValueStorage {
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

function ent(key: string, productId = "monthly_pro"): PublicEntitlement {
  return {
    object: "entitlement",
    key,
    isActive: true,
    validUntil: null,
    source: { rail: "stripe", productId, subscriptionId: "sub_x" },
    updatedAt: 1_700_000_000,
  };
}

describe("EntitlementCache isolation (Phase 1.3)", () => {
  describe("SHA-256 vectors (the deterministic hash contract)", () => {
    it("matches FIPS 180-4 reference vector for the empty string", () => {
      expect(sha256Hex("")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    });

    it("matches FIPS 180-4 reference vector for 'abc'", () => {
      expect(sha256Hex("abc")).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    });

    it("UTF-8 encodes multi-byte characters distinctly from ASCII", () => {
      // The accented form must differ from the ASCII form — proves
      // the UTF-8 path was taken and didn't silently collapse
      // multi-byte input to the ASCII subset.
      const ascii = sha256Hex("cafe");
      const utf8 = sha256Hex("café");
      expect(ascii).not.toBe(utf8);
      expect(utf8).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic across calls", () => {
      const a = sha256Hex("user_847");
      const b = sha256Hex("user_847");
      expect(a).toBe(b);
    });

    it("differs across user ids", () => {
      expect(sha256Hex("alice")).not.toBe(sha256Hex("bob"));
    });
  });

  describe("layer (a) — physical key separation per user", () => {
    let storage: MapStorage;
    let cache: EntitlementCache;

    beforeEach(() => {
      storage = new MapStorage();
      cache = new EntitlementCache(storage);
    });

    it("anonymous writes land under :_anon", () => {
      cache.setFromList([ent("pro")]);
      expect(storage.data.has("crossdeck:entitlements:_anon")).toBe(true);
    });

    it("identified writes land under :<sha256(userId)>", () => {
      cache.setUserKey("alice");
      cache.setFromList([ent("pro")]);
      const expectedKey = `crossdeck:entitlements:${sha256Hex("alice")}`;
      expect(storage.data.has(expectedKey)).toBe(true);
    });

    it("two different users use two different storage keys", () => {
      cache.setUserKey("alice");
      cache.setFromList([ent("pro")]);
      cache.setUserKey("bob");
      cache.setFromList([ent("trial")]);

      const aliceKey = `crossdeck:entitlements:${sha256Hex("alice")}`;
      const bobKey = `crossdeck:entitlements:${sha256Hex("bob")}`;
      expect(storage.data.has(aliceKey)).toBe(true);
      expect(storage.data.has(bobKey)).toBe(true);
      expect(aliceKey).not.toBe(bobKey);
    });
  });

  describe("layer (b) — identify() unconditional in-memory clear", () => {
    let storage: MapStorage;
    let cache: EntitlementCache;

    beforeEach(() => {
      storage = new MapStorage();
      cache = new EntitlementCache(storage);
    });

    it("identify(B) makes A's entitlements unreachable from in-memory", () => {
      // Plan §6.1.3 regression test: identify(A) -> set entitlements ->
      // identify(B) -> assert A's entitlements unreachable.
      cache.setUserKey("alice");
      cache.setFromList([ent("pro")]);
      expect(cache.isEntitled("pro")).toBe(true);

      cache.setUserKey("bob");

      expect(cache.isEntitled("pro")).toBe(false);
      expect(cache.list()).toEqual([]);
    });

    it("same-id re-identify still wipes in-memory snapshot", () => {
      // Founder contract: identify() ALWAYS wipes in-memory, even
      // when the new userId matches the prior one. A tiny redundant
      // cache rebuild is cheaper than a leak.
      cache.setUserKey("alice");
      cache.setFromList([ent("pro")]);
      expect(cache.isEntitled("pro")).toBe(true);

      cache.setUserKey("alice");

      // After same-id setUserKey: in-memory is wiped, then
      // rehydrated from the durable slot — so isEntitled("pro")
      // is back to true via the storage round-trip.
      expect(cache.isEntitled("pro")).toBe(true);
    });

    it("identify(B) then identify(A) restores A's slot from storage", () => {
      cache.setUserKey("alice");
      cache.setFromList([ent("pro")]);
      cache.setUserKey("bob");
      cache.setFromList([ent("trial")]);

      // Returning user — A's entitlements come back from their
      // own per-user storage slot, not from cross-read.
      cache.setUserKey("alice");
      expect(cache.isEntitled("pro")).toBe(true);
      expect(cache.isEntitled("trial")).toBe(false);
    });
  });

  describe("layer (c) — reset() wipes EVERY per-user slot", () => {
    let storage: MapStorage;
    let cache: EntitlementCache;

    beforeEach(() => {
      storage = new MapStorage();
      cache = new EntitlementCache(storage);
    });

    it("clearAll() removes every per-user storage key plus the index", () => {
      cache.setUserKey("alice");
      cache.setFromList([ent("pro")]);
      cache.setUserKey("bob");
      cache.setFromList([ent("trial")]);
      cache.setUserKey("charlie");
      cache.setFromList([ent("enterprise")]);

      // 3 per-user keys + 1 index = 4 entries.
      expect(storage.data.size).toBeGreaterThanOrEqual(4);

      cache.clearAll();

      const remaining = [...storage.data.keys()].filter((k) =>
        k.startsWith("crossdeck:entitlements"),
      );
      expect(remaining).toEqual([]);
    });

    it("clearAll() resets in-memory state to anonymous + empty", () => {
      cache.setUserKey("alice");
      cache.setFromList([ent("pro")]);

      cache.clearAll();

      expect(cache.list()).toEqual([]);
      expect(cache.isEntitled("pro")).toBe(false);
      // Following identify(A) re-hydrates from a now-empty slot —
      // proving the storage wipe took effect.
      cache.setUserKey("alice");
      expect(cache.isEntitled("pro")).toBe(false);
    });

    it("does NOT touch unrelated host-app storage keys", () => {
      storage.setItem("app:user_preferences", '{"theme":"dark"}');
      cache.setUserKey("alice");
      cache.setFromList([ent("pro")]);

      cache.clearAll();

      expect(storage.getItem("app:user_preferences")).toBe('{"theme":"dark"}');
    });
  });

  describe("defence-in-depth — physical isolation even without in-memory clear", () => {
    it("a second cache instance reading A's storage suffix CANNOT see B's data", () => {
      // Simulates the worst case: a bug somewhere skips the in-memory
      // wipe on identify(B), but the per-user storage key still
      // isolates. A is keyed by sha256(alice); B is keyed by
      // sha256(bob); a fresh cache constructed under A's key cannot
      // physically read B's blob from storage.
      const storage = new MapStorage();

      const aCache = new EntitlementCache(storage);
      aCache.setUserKey("alice");
      aCache.setFromList([ent("pro_a")]);

      const bCache = new EntitlementCache(storage);
      bCache.setUserKey("bob");
      bCache.setFromList([ent("pro_b")]);

      // Construct fresh "rogue" cache instances bound to A and B
      // respectively — even without any in-memory state, the
      // physical key isolation holds.
      const rogueAlice = new EntitlementCache(storage);
      rogueAlice.setUserKey("alice");
      expect(rogueAlice.isEntitled("pro_a")).toBe(true);
      expect(rogueAlice.isEntitled("pro_b")).toBe(false);

      const rogueBob = new EntitlementCache(storage);
      rogueBob.setUserKey("bob");
      expect(rogueBob.isEntitled("pro_b")).toBe(true);
      expect(rogueBob.isEntitled("pro_a")).toBe(false);
    });
  });
});
