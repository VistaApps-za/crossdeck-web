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
