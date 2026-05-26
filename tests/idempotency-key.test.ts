// Phase 2.2 contract tests — deterministic Idempotency-Key derivation.
//
// Same input -> same key -> backend short-circuits with
// idempotent_replay: true. A regression here would mean retries
// of the same purchase generate different keys + double-process
// silently — the Stripe-grade contract the SDK promises.

import { describe, it, expect } from "vitest";
import {
  deriveIdempotencyKeyForPurchase,
  formatAsUuid,
} from "../src/idempotency-key";

describe("deriveIdempotencyKeyForPurchase", () => {
  it("cross-SDK oracle — apple JWS pins canonical vector", () => {
    // Canonical vector — same input on Web/Node/RN/Swift/Android
    // MUST produce this exact UUID. Pin computed via:
    //   node -e "const c=require('crypto');console.log(c.createHash('sha256').update('crossdeck:purchases/sync:apple:eyJ.jws.sig').digest('hex'))"
    // = a66b1640efafbb4d12616650033bf111509f0313643d697a1e6963184b31be51
    expect(
      deriveIdempotencyKeyForPurchase({
        rail: "apple",
        signedTransactionInfo: "eyJ.jws.sig",
      }),
    ).toBe("a66b1640-efaf-bb4d-1261-6650033bf111");
  });

  it("is deterministic: same body twice -> identical key", () => {
    const body = {
      rail: "apple",
      signedTransactionInfo: "eyJhbGciOiJFUzI1NiJ9.eyJ0eFRpZCI6IjEifQ.sig",
    };
    expect(deriveIdempotencyKeyForPurchase(body)).toBe(
      deriveIdempotencyKeyForPurchase(body),
    );
  });

  it("produces a UUID-shaped string (8-4-4-4-12 lowercase hex)", () => {
    const key = deriveIdempotencyKeyForPurchase({
      rail: "apple",
      signedTransactionInfo: "eyJ.jws.sig",
    });
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("different signedTransactionInfo -> different key", () => {
    const a = deriveIdempotencyKeyForPurchase({
      rail: "apple",
      signedTransactionInfo: "eyJ.first.jws",
    });
    const b = deriveIdempotencyKeyForPurchase({
      rail: "apple",
      signedTransactionInfo: "eyJ.second.jws",
    });
    expect(a).not.toBe(b);
  });

  it("derives Google rail from purchaseToken", () => {
    const a = deriveIdempotencyKeyForPurchase({
      rail: "google",
      purchaseToken: "play-token-abc",
    });
    const b = deriveIdempotencyKeyForPurchase({
      rail: "google",
      purchaseToken: "play-token-abc",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("same identifier under different rails -> different keys", () => {
    // Defence-in-depth: the namespace prefix includes the rail so
    // an Apple JWS that happens to share bytes with a Google token
    // cannot collide in the idempotency cache.
    const apple = deriveIdempotencyKeyForPurchase({
      rail: "apple",
      signedTransactionInfo: "common-bytes",
    });
    const google = deriveIdempotencyKeyForPurchase({
      rail: "google",
      purchaseToken: "common-bytes",
    });
    expect(apple).not.toBe(google);
  });

  it("throws when no stable identifier is available", () => {
    expect(() =>
      deriveIdempotencyKeyForPurchase({ rail: "apple" }),
    ).toThrow(/signedTransactionInfo/);
    expect(() =>
      deriveIdempotencyKeyForPurchase({ rail: "google" }),
    ).toThrow(/purchaseToken/);
    expect(() =>
      deriveIdempotencyKeyForPurchase({ rail: "stripe" }),
    ).toThrow();
  });

  it("never silently falls back to a random key on missing identifier", () => {
    // Bank-grade contract: missing identifier is a programmer
    // error, not a runtime workaround. Silent random fallback
    // would defeat the very contract this helper enforces.
    try {
      deriveIdempotencyKeyForPurchase({ rail: "apple" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("no stable identifier");
    }
  });
});

describe("formatAsUuid", () => {
  it("formats 32 hex chars as 8-4-4-4-12", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    expect(formatAsUuid(hex)).toBe("01234567-89ab-cdef-0123-456789abcdef");
  });

  it("uses only the first 32 hex chars of longer input", () => {
    const sha256Hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(formatAsUuid(sha256Hex)).toBe("01234567-89ab-cdef-0123-456789abcdef");
  });
});
