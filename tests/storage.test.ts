/**
 * MemoryStorage + detectDefaultStorage tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryStorage, detectDefaultStorage } from "../src/storage";

describe("MemoryStorage", () => {
  it("set/get/remove round-trip", () => {
    const s = new MemoryStorage();
    expect(s.getItem("k")).toBeNull();
    s.setItem("k", "v");
    expect(s.getItem("k")).toBe("v");
    s.removeItem("k");
    expect(s.getItem("k")).toBeNull();
  });

  it("isolated per instance", () => {
    const a = new MemoryStorage();
    const b = new MemoryStorage();
    a.setItem("k", "v");
    expect(b.getItem("k")).toBeNull();
  });

  it("removing a missing key is a no-op (not an error)", () => {
    const s = new MemoryStorage();
    expect(() => s.removeItem("ghost")).not.toThrow();
  });
});

describe("detectDefaultStorage", () => {
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

  afterEach(() => {
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
    }
  });

  it("falls back to MemoryStorage when localStorage is undefined (Node)", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    const storage = detectDefaultStorage();
    expect(storage).toBeInstanceOf(MemoryStorage);
  });

  it("uses localStorage when available", () => {
    const fake = {
      _data: new Map<string, string>(),
      getItem(k: string) {
        return this._data.get(k) ?? null;
      },
      setItem(k: string, v: string) {
        this._data.set(k, v);
      },
      removeItem(k: string) {
        this._data.delete(k);
      },
    };
    (globalThis as { localStorage?: unknown }).localStorage = fake;
    const storage = detectDefaultStorage();
    expect(storage).toBe(fake);
  });

  it("falls back to MemoryStorage when localStorage probe throws (Safari private mode)", () => {
    const throwing = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
      removeItem() {},
    };
    (globalThis as { localStorage?: unknown }).localStorage = throwing;
    const storage = detectDefaultStorage();
    expect(storage).toBeInstanceOf(MemoryStorage);
  });
});
