/**
 * Local cache of active entitlements so isEntitled() can answer
 * synchronously after the first read. Cache is updated:
 *   - On successful getEntitlements()
 *   - On successful purchase()
 *   - Manually via setFromList() (used by callers that batch updates)
 *
 * The cache holds only ACTIVE entitlements — inactive ones are excluded
 * by the backend before they hit us. isEntitled returns false for
 * anything not in the set.
 *
 * Thread / re-entrancy safety: this is a synchronous in-memory Set with
 * no I/O. The async paths that update it are serialised through the
 * SDK's request queue — callers won't see torn reads.
 */

import type { PublicEntitlement } from "./types";

export class EntitlementCache {
  private active = new Set<string>();
  private all: PublicEntitlement[] = [];
  private lastUpdated = 0;

  /** Sync read — true iff the entitlement key is currently active. */
  isEntitled(key: string): boolean {
    return this.active.has(key);
  }

  /** Full snapshot for callers that need source / validUntil details. */
  list(): PublicEntitlement[] {
    return this.all.slice();
  }

  /** When the cache was last refreshed. 0 means "never". */
  get freshness(): number {
    return this.lastUpdated;
  }

  /**
   * Replace the cache with a fresh server response. The backend already
   * filters to active + env-matching, so we don't re-filter — just trust
   * what we got.
   */
  setFromList(entitlements: PublicEntitlement[]): void {
    this.all = entitlements.slice();
    this.active = new Set(entitlements.filter((e) => e.isActive).map((e) => e.key));
    this.lastUpdated = Date.now();
  }

  /**
   * Wipe — used on reset() (logout). The SDK forgets everything until
   * the next identify + read.
   */
  clear(): void {
    this.active.clear();
    this.all = [];
    this.lastUpdated = 0;
  }
}
