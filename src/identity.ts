/**
 * Identity persistence for the SDK.
 *
 * Two values are tracked:
 *   anonymousId          — generated on first boot. Persists for the
 *                          install lifetime so pre-login events stay
 *                          attached to the same identity graph entry.
 *   crossdeckCustomerId  — populated after the first identify() or
 *                          getEntitlements() that resolves a customer.
 *                          Persisted so subsequent boots can read
 *                          entitlements directly without an alias call.
 *
 * ----- Bank-grade identity continuity (v0.6.0+) -----
 *
 * In a browser context, the SDK reads/writes BOTH localStorage and a
 * 1st-party cookie. This is the redundancy that keeps "10k unique
 * visitors" actually meaning 10k humans even when one store is wiped:
 *
 *   - Read on boot: take whichever value exists. If both differ
 *     (impossible in normal operation — would mean one store was
 *     restored from a stale backup), localStorage wins because it's
 *     the higher-fidelity store and what we wrote most recently.
 *   - Write on every change: write to BOTH. Future clears of either
 *     don't lose identity continuity.
 *   - Reset: clear BOTH stores so logout actually wipes the device.
 *
 * Outside browsers (Node, Workers) the redundant cookie store is
 * absent and behaviour collapses to the single-store original — no
 * code path changes for non-web SDK consumers.
 */

import type { KeyValueStorage } from "./types";

const KEY_ANON = "anon_id";
const KEY_CDCUST = "cdcust_id";

export interface IdentityState {
  anonymousId: string;
  crossdeckCustomerId: string | null;
}

export class IdentityStore {
  private state: IdentityState;
  /**
   * Optional secondary store written/read alongside the primary. When
   * present, every setItem fans out to both stores and getItem prefers
   * primary but falls back to secondary if primary returned null. This
   * is what gives us localStorage + cookie redundancy in browsers.
   */
  private readonly secondary: KeyValueStorage | null;

  constructor(
    private readonly primary: KeyValueStorage,
    private readonly prefix: string,
    secondary?: KeyValueStorage,
  ) {
    this.secondary = secondary ?? null;
    const anonFromPrimary = primary.getItem(prefix + KEY_ANON);
    const cdcustFromPrimary = primary.getItem(prefix + KEY_CDCUST);
    const anonFromSecondary = this.secondary?.getItem(prefix + KEY_ANON) ?? null;
    const cdcustFromSecondary = this.secondary?.getItem(prefix + KEY_CDCUST) ?? null;

    // Prefer the primary store's value; fall back to secondary on miss.
    // The "both populated, values differ" case never happens in normal
    // operation — every write goes to both stores in lockstep — so we
    // don't bother with conflict resolution beyond "trust primary."
    const anon = anonFromPrimary ?? anonFromSecondary;
    const cdcust = cdcustFromPrimary ?? cdcustFromSecondary;

    this.state = {
      anonymousId: anon ?? this.mintAnonymousId(),
      crossdeckCustomerId: cdcust,
    };

    // If we just minted a new anonymousId, write it to both stores so
    // either store can answer "what's our id" on subsequent boots.
    // If we read it from one store but not the other, write it to the
    // missing store too — that's the resync that catches a recovering
    // ITP-cleared cookie or a freshly-minted private-tab localStorage.
    if (!anonFromPrimary || !anonFromSecondary) {
      this.writeBoth(prefix + KEY_ANON, this.state.anonymousId);
    }
    if (cdcust && (!cdcustFromPrimary || !cdcustFromSecondary)) {
      this.writeBoth(prefix + KEY_CDCUST, cdcust);
    }
  }

  /** Return the persisted anonymous device ID (always set). */
  get anonymousId(): string {
    return this.state.anonymousId;
  }

  /** Return the resolved cross­deckCustomerId once we have one, else null. */
  get crossdeckCustomerId(): string | null {
    return this.state.crossdeckCustomerId;
  }

  /** Persist a newly-resolved Crossdeck customer ID. */
  setCrossdeckCustomerId(value: string): void {
    this.state.crossdeckCustomerId = value;
    this.writeBoth(this.prefix + KEY_CDCUST, value);
  }

  /**
   * Wipe persisted identity. Called by reset() — used when an end-user
   * logs out. After reset the SDK mints a new anonymousId so the next
   * pre-login session is a fresh customer in the identity graph.
   */
  reset(): void {
    this.deleteBoth(this.prefix + KEY_ANON);
    this.deleteBoth(this.prefix + KEY_CDCUST);
    this.state = {
      anonymousId: this.mintAnonymousId(),
      crossdeckCustomerId: null,
    };
    this.writeBoth(this.prefix + KEY_ANON, this.state.anonymousId);
  }

  /**
   * Generate an anonymousId. Crockford-ish base32 timestamp + random
   * suffix. Same shape Stripe / Segment / others use — sortable, log-
   * friendly, no PII.
   */
  private mintAnonymousId(): string {
    const ts = Date.now().toString(36);
    const rand = randomChars(10);
    return `anon_${ts}${rand}`;
  }

  private writeBoth(key: string, value: string): void {
    try { this.primary.setItem(key, value); } catch { /* see storage.ts probe */ }
    if (this.secondary) {
      try { this.secondary.setItem(key, value); } catch { /* swallow per-store */ }
    }
  }

  private deleteBoth(key: string): void {
    try { this.primary.removeItem(key); } catch { /* swallow */ }
    if (this.secondary) {
      try { this.secondary.removeItem(key); } catch { /* swallow */ }
    }
  }
}

/**
 * Generate a cryptographically-random short string. Uses
 * crypto.getRandomValues when available (browser + Node 18+ via webcrypto),
 * else falls back to Math.random — that fallback is safe here because
 * anonymousId entropy doesn't need to resist offline brute force; it
 * needs to be unique-with-overwhelming-probability across one device's
 * lifetime.
 *
 * Exported for unit testing (alphabet round-trip).
 */
export function randomChars(count: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const out: string[] = [];
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoApi?.getRandomValues) {
    const buf = new Uint8Array(count);
    cryptoApi.getRandomValues(buf);
    for (let i = 0; i < count; i++) {
      out.push(alphabet[buf[i]! % alphabet.length] ?? "0");
    }
  } else {
    for (let i = 0; i < count; i++) {
      out.push(alphabet[Math.floor(Math.random() * alphabet.length)] ?? "0");
    }
  }
  return out.join("");
}
