/**
 * Storage adapters for SDK-persisted state.
 *
 * Two flavours:
 *   - browser localStorage (default in browsers)
 *   - in-memory (default in Node, or as an explicit fallback)
 *
 * Detection is at construction time, not at every call — picking the
 * adapter once means we don't hit `typeof window` checks on hot paths.
 */

import type { KeyValueStorage } from "./types";

/**
 * In-memory storage. Cleared on process exit. Useful for Node runtimes
 * where you want session-scoped identity that doesn't persist to disk.
 */
export class MemoryStorage implements KeyValueStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

/**
 * Pick the best available storage. Browser → localStorage if accessible,
 * else MemoryStorage. Node → MemoryStorage. Caller can override via
 * Crossdeck.start({ storage: ... }) for custom adapters (RN AsyncStorage,
 * Cookies, encrypted vaults, etc.).
 *
 * We probe localStorage with a try/catch because some environments
 * (private mode Safari, embedded webviews) define `localStorage` but
 * throw on every call — falling back to memory keeps us correct.
 */
export function detectDefaultStorage(): KeyValueStorage {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    if (ls) {
      // Probe with a no-op write to confirm we can actually use it.
      const probe = "__crossdeck_probe__";
      ls.setItem(probe, "1");
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    // Private mode / sandboxed iframe / quota exceeded — fall through.
  }
  return new MemoryStorage();
}
