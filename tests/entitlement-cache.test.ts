import { describe, it, expect } from "vitest";
import { EntitlementCache } from "../src/entitlement-cache";
import type { PublicEntitlement } from "../src/types";

function ent(key: string, isActive = true): PublicEntitlement {
  return {
    object: "entitlement",
    key,
    isActive,
    validUntil: null,
    source: { rail: "stripe", productId: "monthly_pro", subscriptionId: "sub_x" },
    updatedAt: 1_700_000_000,
  };
}

describe("EntitlementCache", () => {
  it("isEntitled returns false on a fresh cache", () => {
    const c = new EntitlementCache();
    expect(c.isEntitled("pro")).toBe(false);
  });

  it("setFromList populates the active set", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro"), ent("ai_insights")]);
    expect(c.isEntitled("pro")).toBe(true);
    expect(c.isEntitled("ai_insights")).toBe(true);
    expect(c.isEntitled("garbage")).toBe(false);
  });

  it("inactive entitlements are excluded from isEntitled", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro", true), ent("expired_thing", false)]);
    expect(c.isEntitled("pro")).toBe(true);
    expect(c.isEntitled("expired_thing")).toBe(false);
  });

  it("list() returns a snapshot, not a mutable reference", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro")]);
    const snap = c.list();
    snap.pop(); // mutate the snapshot
    expect(c.list().length).toBe(1); // cache untouched
  });

  it("setFromList replaces, doesn't merge", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro")]);
    c.setFromList([ent("ai_insights")]);
    expect(c.isEntitled("pro")).toBe(false);
    expect(c.isEntitled("ai_insights")).toBe(true);
  });

  it("clear() empties the cache", () => {
    const c = new EntitlementCache();
    c.setFromList([ent("pro")]);
    c.clear();
    expect(c.isEntitled("pro")).toBe(false);
    expect(c.list()).toEqual([]);
  });

  it("freshness updates on every setFromList", () => {
    const c = new EntitlementCache();
    expect(c.freshness).toBe(0);
    c.setFromList([ent("pro")]);
    expect(c.freshness).toBeGreaterThan(0);
  });
});
