/**
 * Deterministic Idempotency-Key derivation for /purchases/sync.
 *
 * Phase 2.2 of bank-grade reconciliation v1.4.0. Pre-v1.4.0 each
 * call minted a fresh random UUID — two retries of the same
 * purchase (network blip, app crash mid-flight, deliberate caller
 * retry) got DIFFERENT keys, so server-side idempotency could not
 * collapse them. The bank-grade contract every Stripe-grade API
 * ships: same input → same key → same response.
 *
 * Algorithm:
 *   1. Extract a stable identifier from the request body:
 *      - Apple: the signed JWS string (uniquely identifies the
 *        transaction by Apple's signature).
 *      - Google: the purchaseToken.
 *   2. SHA-256 the identifier.
 *   3. Format the first 32 hex chars of the digest as a UUID-shaped
 *      string (8-4-4-4-12). Backend treats the key as opaque so
 *      RFC 4122 version/variant bits are unnecessary — what matters
 *      is determinism.
 *
 * The resulting key is identical across retries of the same
 * transaction, so the backend's idempotency cache short-circuits
 * with `idempotent_replay: true` in the response.
 */

import { sha256Hex } from "./hash";

export interface PurchaseSyncIdentity {
  rail: "apple" | "google" | "stripe" | string;
  signedTransactionInfo?: string;
  purchaseToken?: string;
}

/**
 * Format a hex string as `8-4-4-4-12` UUID shape using its first
 * 32 hex chars. Used for the idempotency-key derivation — the
 * shape matches what backend logs / dashboards already pattern-
 * match against; treating it as a UUID at the wire makes
 * inspection familiar even though it isn't RFC 4122 versioned.
 */
export function formatAsUuid(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Deterministic Idempotency-Key for a purchase sync. Returns the
 * canonical UUID-shaped string the SDK sends as the
 * `Idempotency-Key` header.
 *
 * Same input → same key → backend returns the cached response
 * with `idempotent_replay: true` instead of double-processing.
 *
 * Throws on bodies that have no stable identifier — never silently
 * fall back to a fresh random key, since that would defeat the
 * very contract this helper exists to enforce.
 */
export function deriveIdempotencyKeyForPurchase(body: PurchaseSyncIdentity): string {
  let identifier: string;
  if (body.rail === "apple") {
    identifier = body.signedTransactionInfo ?? "";
  } else if (body.rail === "google") {
    identifier = body.purchaseToken ?? "";
  } else {
    identifier = "";
  }
  if (!identifier) {
    throw new Error(
      `deriveIdempotencyKeyForPurchase: no stable identifier in body ` +
        `(rail=${body.rail}). Apple needs signedTransactionInfo; ` +
        `Google needs purchaseToken.`,
    );
  }
  // Namespace the digest so the same JWS used by /purchases/sync
  // and a hypothetical future /purchases/verify produce DIFFERENT
  // keys — prevents cross-endpoint idempotency collisions.
  const namespaced = `crossdeck:purchases/sync:${body.rail}:${identifier}`;
  return formatAsUuid(sha256Hex(namespaced));
}
