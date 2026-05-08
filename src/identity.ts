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

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly prefix: string
  ) {
    const stored = {
      anon: storage.getItem(prefix + KEY_ANON),
      cdcust: storage.getItem(prefix + KEY_CDCUST),
    };
    this.state = {
      anonymousId: stored.anon ?? this.mintAnonymousId(),
      crossdeckCustomerId: stored.cdcust,
    };
    if (!stored.anon) {
      storage.setItem(prefix + KEY_ANON, this.state.anonymousId);
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
    this.storage.setItem(this.prefix + KEY_CDCUST, value);
  }

  /**
   * Wipe persisted identity. Called by reset() — used when an end-user
   * logs out. After reset the SDK mints a new anonymousId so the next
   * pre-login session is a fresh customer in the identity graph.
   */
  reset(): void {
    this.storage.removeItem(this.prefix + KEY_ANON);
    this.storage.removeItem(this.prefix + KEY_CDCUST);
    this.state = {
      anonymousId: this.mintAnonymousId(),
      crossdeckCustomerId: null,
    };
    this.storage.setItem(this.prefix + KEY_ANON, this.state.anonymousId);
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
