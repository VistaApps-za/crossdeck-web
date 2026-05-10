/**
 * Storage adapters for SDK-persisted state.
 *
 * Three flavours:
 *   - browser localStorage (default in browsers)
 *   - 1st-party document.cookie (redundancy for cleared localStorage)
 *   - in-memory (default in Node, or as an explicit fallback)
 *
 * Detection is at construction time, not at every call — picking the
 * adapter once means we don't hit `typeof window` checks on hot paths.
 *
 * ----- Bank-grade identity continuity -----
 *
 * Plain localStorage is not enough. ITP, private browsing, "clear site
 * data" actions, and aggressive privacy extensions all wipe it. When
 * that happens, the SDK mints a fresh anonymousId on next page load
 * and the customer's analytics see one human as multiple "new
 * visitors" — a credibility hit on every dashboard chart that depends
 * on visitor uniqueness (new vs returning, retention, funnels).
 *
 * The fix is redundancy: we write the same identity to BOTH
 * localStorage AND a 1st-party cookie. On boot we read both; whichever
 * survived wins. On set, we write to both stores so a future clear of
 * either doesn't lose the user.
 *
 * Caveats (documented honestly):
 *   1. Safari ITP caps client-set 1st-party cookies at 7 days. Cookie
 *      redundancy protects against localStorage clears WITHIN that
 *      7-day window, not beyond it. The full ITP-bypass story (server-
 *      set cookies via a customer-CNAMEd subdomain) is a Phase 2
 *      follow-up that requires customer DNS configuration.
 *   2. We never write fingerprintable data — only the same anonymousId
 *      already in localStorage. Privacy posture is unchanged from
 *      single-store identity.
 *   3. `persistIdentity: false` disables BOTH stores so customers
 *      running strict consent flows can defer cookie writes until the
 *      user opts in.
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
 * 1st-party cookie storage. All writes set:
 *   - Path=/                — visible site-wide so SPA route changes
 *                             keep the same identity
 *   - Max-Age=63072000      — 2 years (clamped to 7 days by Safari ITP
 *                             but written long anyway for non-ITP UAs)
 *   - SameSite=Lax          — standard for 1st-party identity, blocks
 *                             cross-site request abuse but allows
 *                             top-level navigation reads
 *   - Secure                — only set when page is served over HTTPS;
 *                             omitted on http://localhost so dev still
 *                             works without a TLS cert
 *
 * We do NOT set HttpOnly because the SDK itself needs to read the
 * cookie via document.cookie to honour the redundancy contract. That
 * means malicious JS on the same origin could read the anonymousId,
 * which is the same security posture as localStorage — anything that
 * can read localStorage can read this cookie. Stripe, Segment, and
 * PostHog ship with the same trade-off for the same reason.
 *
 * Empty / unparseable cookie strings degrade silently to null. We never
 * throw — a broken cookie should look identical to "no cookie set."
 */
export class CookieStorage implements KeyValueStorage {
  private readonly maxAgeSec: number;
  private readonly secure: boolean;
  private readonly sameSite: "Lax" | "Strict" | "None";

  constructor(options?: {
    maxAgeSec?: number;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
  }) {
    this.maxAgeSec = options?.maxAgeSec ?? 63_072_000; // 2 years
    this.secure = options?.secure ?? defaultSecure();
    this.sameSite = options?.sameSite ?? "Lax";
  }

  getItem(key: string): string | null {
    if (!hasDocument()) return null;
    const doc = (globalThis as { document: Document }).document;
    const cookies = doc.cookie ? doc.cookie.split(/;\s*/) : [];
    const prefix = encodeURIComponent(key) + "=";
    for (const c of cookies) {
      if (c.startsWith(prefix)) {
        try {
          return decodeURIComponent(c.slice(prefix.length));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  setItem(key: string, value: string): void {
    if (!hasDocument()) return;
    const doc = (globalThis as { document: Document }).document;
    const parts = [
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      "Path=/",
      `Max-Age=${this.maxAgeSec}`,
      `SameSite=${this.sameSite}`,
    ];
    if (this.secure) parts.push("Secure");
    try {
      doc.cookie = parts.join("; ");
    } catch {
      // Some embedded webviews block document.cookie writes — swallow.
      // localStorage redundancy still gives us identity continuity.
    }
  }

  removeItem(key: string): void {
    if (!hasDocument()) return;
    const doc = (globalThis as { document: Document }).document;
    // Negative Max-Age + matching path expires the cookie immediately.
    // We keep the same SameSite/Secure attributes so browsers actually
    // accept the deletion request as targeting the same cookie.
    const parts = [
      `${encodeURIComponent(key)}=`,
      "Path=/",
      "Max-Age=0",
      `SameSite=${this.sameSite}`,
    ];
    if (this.secure) parts.push("Secure");
    try {
      doc.cookie = parts.join("; ");
    } catch {
      // Same reasoning as setItem — swallow.
    }
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

/**
 * Detect whether the current page is served over HTTPS so we can set
 * the Secure cookie attribute. Defensive against environments where
 * `location` is missing (Workers, server-rendered pre-hydration).
 */
function defaultSecure(): boolean {
  try {
    const loc = (globalThis as { location?: Location }).location;
    return loc?.protocol === "https:";
  } catch {
    return false;
  }
}

function hasDocument(): boolean {
  return typeof (globalThis as { document?: unknown }).document !== "undefined";
}
