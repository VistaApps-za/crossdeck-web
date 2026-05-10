import { describe, it, expect } from "vitest";
import { IdentityStore, randomChars } from "../src/identity";
import { MemoryStorage } from "../src/storage";

describe("IdentityStore", () => {
  it("generates a fresh anonymousId on first boot", () => {
    const id = new IdentityStore(new MemoryStorage(), "x:");
    expect(id.anonymousId).toMatch(/^anon_/);
    expect(id.crossdeckCustomerId).toBeNull();
  });

  it("persists anonymousId across re-instantiation (same storage)", () => {
    const storage = new MemoryStorage();
    const a = new IdentityStore(storage, "x:");
    const firstAnon = a.anonymousId;
    const b = new IdentityStore(storage, "x:");
    expect(b.anonymousId).toBe(firstAnon);
  });

  it("sets and persists crossdeckCustomerId", () => {
    const storage = new MemoryStorage();
    const a = new IdentityStore(storage, "x:");
    a.setCrossdeckCustomerId("cdcust_test_001");
    expect(a.crossdeckCustomerId).toBe("cdcust_test_001");

    const b = new IdentityStore(storage, "x:");
    expect(b.crossdeckCustomerId).toBe("cdcust_test_001");
  });

  it("reset() wipes both identity values and mints a new anonymousId", () => {
    const storage = new MemoryStorage();
    const id = new IdentityStore(storage, "x:");
    const first = id.anonymousId;
    id.setCrossdeckCustomerId("cdcust_x");
    id.reset();
    expect(id.anonymousId).not.toBe(first);
    expect(id.anonymousId).toMatch(/^anon_/);
    expect(id.crossdeckCustomerId).toBeNull();
  });

  it("storagePrefix isolates IdentityStores from each other", () => {
    const storage = new MemoryStorage();
    const a = new IdentityStore(storage, "alpha:");
    const b = new IdentityStore(storage, "beta:");
    expect(a.anonymousId).not.toBe(b.anonymousId);
    a.setCrossdeckCustomerId("cdcust_a");
    expect(b.crossdeckCustomerId).toBeNull();
  });

  // ---- v0.6.0: bank-grade redundancy ----
  // The redundancy contract is "writes go to both stores; reads prefer
  // primary, fall back to secondary." These tests prove every branch
  // of that logic so a future refactor can't silently regress it.

  describe("dual-store redundancy (v0.6.0)", () => {
    it("writes anonymousId to BOTH stores on first boot", () => {
      const primary = new MemoryStorage();
      const secondary = new MemoryStorage();
      const id = new IdentityStore(primary, "x:", secondary);
      expect(primary.getItem("x:anon_id")).toBe(id.anonymousId);
      expect(secondary.getItem("x:anon_id")).toBe(id.anonymousId);
    });

    it("recovers anonymousId from secondary when primary was cleared", () => {
      // Simulate: a previous session wrote to both. localStorage was
      // then cleared (Safari ITP, Clear Site Data, private browsing).
      // The cookie survived. Next boot must recover the SAME identity
      // — not mint a new one.
      const primary = new MemoryStorage();
      const secondary = new MemoryStorage();
      secondary.setItem("x:anon_id", "anon_survived");
      secondary.setItem("x:cdcust_id", "cdcust_kept");

      const id = new IdentityStore(primary, "x:", secondary);
      expect(id.anonymousId).toBe("anon_survived");
      expect(id.crossdeckCustomerId).toBe("cdcust_kept");
      // And primary gets resynced so future reads are fast
      expect(primary.getItem("x:anon_id")).toBe("anon_survived");
      expect(primary.getItem("x:cdcust_id")).toBe("cdcust_kept");
    });

    it("recovers anonymousId from primary when secondary was cleared", () => {
      // Mirror case: cookies disabled by user, localStorage retained.
      const primary = new MemoryStorage();
      const secondary = new MemoryStorage();
      primary.setItem("x:anon_id", "anon_in_ls");

      const id = new IdentityStore(primary, "x:", secondary);
      expect(id.anonymousId).toBe("anon_in_ls");
      // Secondary gets resynced for the next round of redundancy
      expect(secondary.getItem("x:anon_id")).toBe("anon_in_ls");
    });

    it("primary value wins when both stores have different ids", () => {
      // Edge case: one store was restored from a stale backup. We
      // trust the higher-fidelity primary (localStorage) and resync
      // the secondary — never silently regress to an older id.
      const primary = new MemoryStorage();
      const secondary = new MemoryStorage();
      primary.setItem("x:anon_id", "anon_current");
      secondary.setItem("x:anon_id", "anon_stale_from_backup");

      const id = new IdentityStore(primary, "x:", secondary);
      expect(id.anonymousId).toBe("anon_current");
    });

    it("setCrossdeckCustomerId writes to both stores", () => {
      const primary = new MemoryStorage();
      const secondary = new MemoryStorage();
      const id = new IdentityStore(primary, "x:", secondary);
      id.setCrossdeckCustomerId("cdcust_xyz");
      expect(primary.getItem("x:cdcust_id")).toBe("cdcust_xyz");
      expect(secondary.getItem("x:cdcust_id")).toBe("cdcust_xyz");
    });

    it("reset() wipes both stores and re-writes new anonymousId to both", () => {
      const primary = new MemoryStorage();
      const secondary = new MemoryStorage();
      const id = new IdentityStore(primary, "x:", secondary);
      const before = id.anonymousId;
      id.setCrossdeckCustomerId("cdcust_y");
      id.reset();

      expect(id.anonymousId).not.toBe(before);
      expect(id.crossdeckCustomerId).toBeNull();
      expect(primary.getItem("x:cdcust_id")).toBeNull();
      expect(secondary.getItem("x:cdcust_id")).toBeNull();
      expect(primary.getItem("x:anon_id")).toBe(id.anonymousId);
      expect(secondary.getItem("x:anon_id")).toBe(id.anonymousId);
    });

    it("a throwing secondary doesn't crash primary writes (defence in depth)", () => {
      // Simulate a third-party blocker that throws on every cookie
      // write. Primary writes must still succeed — the SDK never
      // crashes because of redundancy bookkeeping.
      const primary = new MemoryStorage();
      const throwing = {
        getItem: () => null,
        setItem: () => { throw new Error("blocked by extension"); },
        removeItem: () => { throw new Error("blocked"); },
      };
      const id = new IdentityStore(primary, "x:", throwing);
      expect(id.anonymousId).toMatch(/^anon_/);
      expect(primary.getItem("x:anon_id")).toBe(id.anonymousId);
      expect(() => id.setCrossdeckCustomerId("cdcust_a")).not.toThrow();
      expect(() => id.reset()).not.toThrow();
    });
  });
});

describe("randomChars", () => {
  it("returns a string of the requested length", () => {
    expect(randomChars(8).length).toBe(8);
    expect(randomChars(32).length).toBe(32);
  });

  it("uses only the lowercase alphanumeric alphabet", () => {
    const s = randomChars(200);
    expect(s).toMatch(/^[0-9a-z]+$/);
  });

  it("is unlikely to repeat across calls (entropy sanity check)", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 200; i++) samples.add(randomChars(10));
    expect(samples.size).toBeGreaterThan(195); // ≤ 5 collisions in 200 trials
  });
});
