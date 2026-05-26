#!/usr/bin/env node
/**
 * Bundle-size budget enforcement.
 *
 * Runs after `npm run build` (via `npm run size`) and fails the
 * release if any of the published bundles exceeds its budget. The
 * budgets are gzipped-byte counts — what actually goes over the
 * wire when a CDN serves the file.
 *
 * Why this matters: an SDK that crept to 100 KB silently would be a
 * conversion-rate-killer for every customer's site. Locking in a
 * budget at release time is what Stripe / Mixpanel do too.
 *
 * Budgets are intentionally generous on the first release of each
 * subpackage; tighten later as we see the real shape.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const distDir = path.resolve(new URL(".", import.meta.url).pathname, "../dist");

// Budgets target the gzipped wire size. The React / Vue subpackages
// re-bundle the core (splitting: false in tsup.config.ts — keeps the
// publish artefact dependency-free and tree-shake-friendly for
// bundlers). Consumers only pay for ONE entry point, never both.
//
// For comparison (single-pillar SDKs):
//   Mixpanel-browser:   55 KB gz (analytics only)
//   Segment analytics.js: 30 KB gz (analytics only)
//   PostHog-js:         40 KB gz (analytics only)
//   Sentry browser:     30 KB gz (errors only)
//   RevenueCat web:     ~18 KB gz (revenue only)
//
// Crossdeck at ~30 KB ships all three (analytics + revenue + errors)
// in one bundle — competitive with single-pillar SDKs.
// Budgets raised for v1.1.0 (May 2026): the durable last-known-good
// entitlement cache + staleness signal add device-storage
// persistence, boot hydration, and refresh-failure tracking —
// ~0.8 KB gzipped of real code. core ESM 32 → 33 KB, core CJS
// 33 → 34 KB (CJS also carries CommonJS boilerplate the ESM build
// avoids), react / vue ESM 32 → 33 KB. The UMD build holds at 18 KB.
// Still well under the single-pillar competitive ceiling — Sentry
// 30 KB (errors-only), Mixpanel 55 KB (analytics-only), PostHog
// 40 KB (analytics-only) — for one bundle that ships all three
// pillars.
//
// Budgets raised again May 2026 — Batch B audit fix (PR #390): the
// queue's pendingBatch slot, persistAll(), isPermanent4xx() helper,
// onPermanentFailure callback, and the loud `console.error` +
// `sdk.flush_permanent_failure` debug signal add ~1.5 KB gzipped of
// non-removable bank-grade durability code. Pre-fix the queue lost
// the in-flight batch on a hard-crash mid-flight AND retried 4xx
// errors forever with the same Idempotency-Key. Costs +2 KB across
// the bundles; still under every single-pillar competitor's ceiling.
// core ESM 33 → 35 KB, core CJS 34 → 36 KB, react / vue ESM 33 → 35
// KB, UMD 18 → 19 KB.
//
// Budgets raised again v1.4.0 (May 2026) — Phase 1.3 of bank-grade
// reconciliation: the per-user entitlement-cache isolation needs a
// sync SHA-256 over developerUserId so storage keys are physically
// separated per user (`crossdeck:entitlements:<sha256>`). Pure-JS
// SHA-256 (~80 LOC + K constants) adds ~2 KB gzipped — the explicit
// tradeoff for keeping setFromList/clear/hydrate sync (no
// SubtleCrypto async cascade through identify()/getEntitlements()/
// useEntitlement) AND working on RN/Hermes without a polyfill dep.
// Still well under every single-pillar competitor's ceiling.
// core ESM 35 → 38 KB, core CJS 36 → 39 KB, react / vue ESM 35 → 38
// KB, UMD 19 → 21 KB.
//
// Budgets nudged again v1.4.0 (May 2026) — Phase 2.2.a + 3.5 added
// idempotency-key derivation (~0.4 KB) + purchase.completed funnel
// emission (~0.1 KB) on the syncPurchases path. Cumulative pushed
// core ESM to ~38.05 KB; raise to 39 KB across the ESM bundles to
// stay one safety-margin KB above current size.
//
// Budgets nudged again v1.4.0 (May 2026) — Phase 6.2 SDK error-
// codes catalogue backfill added 15 backend-emitted code entries
// per SDK (description + resolution + retryable flag each) so
// getErrorCode() returns Stripe-style remediation for every wire
// code instead of `undefined`. ~1 KB gzipped. Raise core ESM
// 39 → 41, core CJS 40 → 42, react/vue ESM 39 → 41, UMD 21 → 23.
// Still well below every single-pillar competitor's ceiling.
const BUDGETS = [
  { file: "index.mjs", maxGzipKb: 41, label: "core ESM" },
  { file: "index.cjs", maxGzipKb: 42, label: "core CJS" },
  { file: "react.mjs", maxGzipKb: 41, label: "react ESM" },
  { file: "vue.mjs", maxGzipKb: 41, label: "vue ESM" },
  { file: "crossdeck.umd.min.js", maxGzipKb: 23, label: "UMD min" },
];

let failed = false;
console.log("\nBundle-size budget check (gzipped):");
console.log("─".repeat(60));

for (const { file, maxGzipKb, label } of BUDGETS) {
  const full = path.join(distDir, file);
  if (!fs.existsSync(full)) {
    console.log(`  ${label.padEnd(14)}  ${file.padEnd(28)}  MISSING`);
    failed = true;
    continue;
  }
  const raw = fs.readFileSync(full);
  const gzip = zlib.gzipSync(raw);
  const kb = gzip.length / 1024;
  const ok = kb <= maxGzipKb;
  const status = ok ? "ok" : "FAIL";
  const bar = `${kb.toFixed(2).padStart(6)} KB / ${String(maxGzipKb).padStart(3)} KB`;
  console.log(`  ${label.padEnd(14)}  ${file.padEnd(28)}  ${bar}  ${status}`);
  if (!ok) failed = true;
}

console.log("─".repeat(60));
if (failed) {
  console.error(
    "\nBundle-size budget exceeded. Either trim the change or update the\n" +
      "budget in scripts/check-bundle-size.mjs with a justifying CHANGELOG note.\n",
  );
  process.exit(1);
}
console.log("All bundles within budget.\n");
