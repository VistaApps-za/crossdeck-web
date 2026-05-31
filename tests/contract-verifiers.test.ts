/**
 * Tests for the contract verifier layer.
 *
 * Covers:
 *   - Every bootTest happy path (each verifier returns ok:true with
 *     the expected evidence shape).
 *   - VerifierReporter routing rules:
 *       * PASS + logVerifierResults=true     → console.info / debug
 *       * PASS + logVerifierResults=false    → silent
 *       * FAIL                                → console.warn ALWAYS
 *       * FAIL                                → telemetry ALWAYS
 *       * disableContractAssertions=true     → entirely silent
 *   - Re-entrancy guard: a verifier-on-the-telemetry-path that
 *     itself triggers a failure cannot infinite-loop.
 *   - defaultDebugModeFlag detection.
 *   - Cross-SDK canonical idempotency vector (apple JWS pins
 *     `a66b1640-efaf-bb4d-1261-6650033bf111` — drift here breaks the
 *     entire idempotency scheme).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  STATIC_VERIFIERS,
  VerifierReporter,
  buildVerifierContext,
  buildFlushIntervalVerifier,
  defaultDebugModeFlag,
  runBootSelfTest,
  type VerifierContext,
  type VerifierResult,
} from "../src/_contract-verifiers";

// ----------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------

interface ConsoleSpy {
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
}

function makeConsoleSpy(): ConsoleSpy {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

function makeContext(overrides: Partial<{
  logVerifierResults: boolean;
  disableContractAssertions: boolean;
}> = {}): {
  ctx: VerifierContext;
  consoleSpy: ConsoleSpy;
  telemetrySpy: ReturnType<typeof vi.fn>;
} {
  const consoleSpy = makeConsoleSpy();
  const telemetrySpy = vi.fn();
  const ctx: VerifierContext = {
    sdkVersion: "@cross-deck/web@test",
    runId: "cd_verify_test1234",
    runContext: "ci",
    logVerifierResults: overrides.logVerifierResults ?? true,
    disableContractAssertions: overrides.disableContractAssertions ?? false,
    console: consoleSpy,
    emitTelemetry: telemetrySpy,
  };
  return { ctx, consoleSpy, telemetrySpy };
}

// ----------------------------------------------------------------------
// Boot self-test — every verifier returns ok:true on a clean SDK.
// ----------------------------------------------------------------------

describe("runBootSelfTest", () => {
  it("runs every applicable verifier and returns a summary", async () => {
    const { ctx, consoleSpy, telemetrySpy } = makeContext();
    const reporter = new VerifierReporter(ctx);

    const summary = await runBootSelfTest(STATIC_VERIFIERS, reporter, ctx);

    // Every static verifier with a bootTest must pass on a clean SDK.
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThan(0);
    // No FAIL means no telemetry was sent.
    expect(telemetrySpy).not.toHaveBeenCalled();
    // PASS lines went to console.info (boot phase).
    expect(consoleSpy.info).toHaveBeenCalled();
    expect(consoleSpy.warn).not.toHaveBeenCalled();
  });

  it("prints a summary line after the per-test lines", async () => {
    const { ctx, consoleSpy } = makeContext();
    const reporter = new VerifierReporter(ctx);

    await runBootSelfTest(STATIC_VERIFIERS, reporter, ctx);

    const calls = consoleSpy.info.mock.calls.map((c) => String(c[0]));
    const summaryLine = calls.find((l) =>
      l.includes("Self-verification") && l.includes("passed"),
    );
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/\d+ passed, \d+ failed/);
  });

  it("short-circuits when disableContractAssertions is true", async () => {
    const { ctx, consoleSpy, telemetrySpy } = makeContext({
      disableContractAssertions: true,
    });
    const reporter = new VerifierReporter(ctx);

    const summary = await runBootSelfTest(STATIC_VERIFIERS, reporter, ctx);

    expect(summary).toEqual({ passed: 0, failed: 0, totalMs: 0 });
    expect(consoleSpy.info).not.toHaveBeenCalled();
    expect(consoleSpy.debug).not.toHaveBeenCalled();
    expect(consoleSpy.warn).not.toHaveBeenCalled();
    expect(telemetrySpy).not.toHaveBeenCalled();
  });

  it("suppresses console PASS lines when logVerifierResults is false", async () => {
    const { ctx, consoleSpy } = makeContext({ logVerifierResults: false });
    const reporter = new VerifierReporter(ctx);

    await runBootSelfTest(STATIC_VERIFIERS, reporter, ctx);

    // No PASS lines + no summary line — but warn is still possible if
    // any verifier failed (it shouldn't on a clean SDK).
    expect(consoleSpy.info).not.toHaveBeenCalled();
    expect(consoleSpy.debug).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------
// Per-verifier bootTest happy paths
// ----------------------------------------------------------------------

describe("Per-verifier bootTest happy paths", () => {
  it("per-user-cache-isolation passes with evidence", async () => {
    const v = STATIC_VERIFIERS.find(
      (x) => x.contractId === "per-user-cache-isolation",
    );
    expect(v).toBeDefined();
    expect(v!.bootTest).toBeDefined();
    const result = await v!.bootTest!();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contractId).toBe("per-user-cache-isolation");
      expect(result.evidence).toMatch(/slot rotated/);
      expect(result.evidence).toMatch(/isolated, physically separate/);
    }
  });

  it("idempotency-key-deterministic pins the canonical apple JWS vector", async () => {
    const v = STATIC_VERIFIERS.find(
      (x) => x.contractId === "idempotency-key-deterministic",
    );
    expect(v).toBeDefined();
    const result = await v!.bootTest!();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The exact canonical UUID — drift here breaks every other SDK.
      expect(result.evidence).toContain(
        "a66b1640-efaf-bb4d-1261-6650033bf111",
      );
    }
  });

  it("error-envelope-shape verifies a Stripe-shape envelope", async () => {
    const v = STATIC_VERIFIERS.find(
      (x) => x.contractId === "error-envelope-shape",
    );
    expect(v).toBeDefined();
    const result = await v!.bootTest!();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toContain("type, code, message, request_id");
    }
  });

  it("flush-interval-parity verifies the 2000ms default", async () => {
    const v = STATIC_VERIFIERS.find(
      (x) => x.contractId === "flush-interval-parity",
    );
    expect(v).toBeDefined();
    const result = await v!.bootTest!();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toContain("2000");
    }
  });

  it("super-property-merge-precedence verifies caller > super > device", async () => {
    const v = STATIC_VERIFIERS.find(
      (x) => x.contractId === "super-property-merge-precedence",
    );
    expect(v).toBeDefined();
    const result = await v!.bootTest!();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toContain("caller > super > device");
    }
  });

  it("sdk-error-codes-catalogue covers every backend wire code with remediation", async () => {
    const v = STATIC_VERIFIERS.find(
      (x) => x.contractId === "sdk-error-codes-catalogue",
    );
    expect(v).toBeDefined();
    const result = await v!.bootTest!();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toContain("backend wire codes");
    }
  });
});

// ----------------------------------------------------------------------
// buildFlushIntervalVerifier — runtime-configured variant
// ----------------------------------------------------------------------

describe("buildFlushIntervalVerifier", () => {
  it("passes for the canonical 2000ms default", async () => {
    const v = buildFlushIntervalVerifier(2000);
    const result = await v.bootTest!();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toContain("2000ms (canonical default)");
    }
  });

  it("passes (with override notice) for a non-canonical-but-reasonable value", async () => {
    const v = buildFlushIntervalVerifier(5000);
    const result = await v.bootTest!();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence).toContain("5000ms");
      expect(result.evidence).toContain("override");
    }
  });

  it("fails for an out-of-range configured value", async () => {
    const v = buildFlushIntervalVerifier(99); // below floor (100ms)
    const result = await v.bootTest!();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failureReason).toContain("outside reasonable bounds");
    }
  });

  it("fails for a configured value above the ceiling", async () => {
    const v = buildFlushIntervalVerifier(120_000); // 2 minutes
    const result = await v.bootTest!();
    expect(result.ok).toBe(false);
  });
});

// ----------------------------------------------------------------------
// VerifierReporter routing rules
// ----------------------------------------------------------------------

describe("VerifierReporter — routing rules", () => {
  const passResult: VerifierResult = {
    ok: true,
    contractId: "demo-contract",
    evidence: "demo evidence",
    durationMs: 1,
  };
  const failResult: VerifierResult = {
    ok: false,
    contractId: "demo-contract",
    failureReason: "demo failure",
    durationMs: 1,
  };

  it("PASS + logVerifierResults=true (boot) prints to console.info", () => {
    const { ctx, consoleSpy, telemetrySpy } = makeContext({
      logVerifierResults: true,
    });
    new VerifierReporter(ctx).report(passResult, "boot");
    expect(consoleSpy.info).toHaveBeenCalledOnce();
    expect(consoleSpy.debug).not.toHaveBeenCalled();
    expect(consoleSpy.warn).not.toHaveBeenCalled();
    expect(telemetrySpy).not.toHaveBeenCalled();
  });

  it("PASS + logVerifierResults=true (hot_path) prints to console.debug", () => {
    const { ctx, consoleSpy } = makeContext({ logVerifierResults: true });
    new VerifierReporter(ctx).report(passResult, "hot_path", "identify");
    expect(consoleSpy.debug).toHaveBeenCalledOnce();
    expect(consoleSpy.info).not.toHaveBeenCalled();
    const line = String(consoleSpy.debug.mock.calls[0]![0]);
    expect(line).toMatch(/^\[crossdeck\.identify\] ✓/);
  });

  it("PASS + logVerifierResults=false is silent", () => {
    const { ctx, consoleSpy, telemetrySpy } = makeContext({
      logVerifierResults: false,
    });
    new VerifierReporter(ctx).report(passResult, "boot");
    new VerifierReporter(ctx).report(passResult, "hot_path", "identify");
    expect(consoleSpy.info).not.toHaveBeenCalled();
    expect(consoleSpy.debug).not.toHaveBeenCalled();
    expect(consoleSpy.warn).not.toHaveBeenCalled();
    expect(telemetrySpy).not.toHaveBeenCalled();
  });

  it("FAIL prints to console.warn AND fires telemetry, even with logVerifierResults=false", () => {
    const { ctx, consoleSpy, telemetrySpy } = makeContext({
      logVerifierResults: false,
    });
    new VerifierReporter(ctx).report(failResult, "hot_path", "identify");
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
    expect(telemetrySpy).toHaveBeenCalledOnce();
  });

  it("FAIL telemetry carries verification_phase + contract_id + failure_reason", () => {
    const { ctx, telemetrySpy } = makeContext();
    new VerifierReporter(ctx).report(failResult, "boot");
    expect(telemetrySpy).toHaveBeenCalledOnce();
    const payload = telemetrySpy.mock.calls[0]![0];
    expect(payload).toMatchObject({
      contract_id: "demo-contract",
      sdk_platform: "web",
      failure_reason: "demo failure",
      run_context: "ci",
      verification_phase: "boot",
    });
    expect(payload.run_id).toBe("cd_verify_test1234");
  });

  it("FAIL telemetry truncates oversized failure_reason to 128 chars", () => {
    const { ctx, telemetrySpy } = makeContext();
    const oversized = "x".repeat(500);
    new VerifierReporter(ctx).report(
      { ok: false, contractId: "demo", failureReason: oversized, durationMs: 0 },
      "hot_path",
      "track",
    );
    const payload = telemetrySpy.mock.calls[0]![0];
    expect(payload.failure_reason.length).toBeLessThanOrEqual(128);
  });

  it("disableContractAssertions=true silences EVERYTHING (PASS and FAIL)", () => {
    const { ctx, consoleSpy, telemetrySpy } = makeContext({
      disableContractAssertions: true,
    });
    new VerifierReporter(ctx).report(passResult, "boot");
    new VerifierReporter(ctx).report(failResult, "hot_path", "identify");
    expect(consoleSpy.info).not.toHaveBeenCalled();
    expect(consoleSpy.debug).not.toHaveBeenCalled();
    expect(consoleSpy.warn).not.toHaveBeenCalled();
    expect(telemetrySpy).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------
// Re-entrancy guard
// ----------------------------------------------------------------------

describe("VerifierReporter — re-entrancy guard", () => {
  it("does not infinite-loop when a verifier-fired telemetry call itself triggers a failure", () => {
    const { ctx, telemetrySpy } = makeContext();
    // emitTelemetry that itself reports a failure (simulating the
    // contract-failed-payload-schema-lock verifier observing a
    // malformed payload mid-send).
    let depth = 0;
    let maxDepth = 0;
    const reporter = new VerifierReporter({
      ...ctx,
      emitTelemetry: () => {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
        // Recursively trigger another failure report. Without the
        // re-entrancy guard, this would stack-overflow.
        reporter.report(
          { ok: false, contractId: "demo", failureReason: "nested", durationMs: 0 },
          "hot_path",
          "report",
        );
        depth -= 1;
      },
    });

    reporter.report(
      { ok: false, contractId: "demo", failureReason: "outer", durationMs: 0 },
      "hot_path",
      "report",
    );

    // The outer report fires emitTelemetry once; the nested report's
    // attempt to fire telemetry is short-circuited by the guard. The
    // outer report's WARN line still printed; so did the nested one
    // (WARN is independent of the guard). Telemetry hit exactly once.
    expect(telemetrySpy).toHaveBeenCalledTimes(0); // overridden — not called
    expect(maxDepth).toBe(1); // guard prevented depth > 1
  });
});

// ----------------------------------------------------------------------
// defaultDebugModeFlag
// ----------------------------------------------------------------------

describe("defaultDebugModeFlag", () => {
  it("returns true when process.env.NODE_ENV is 'development'", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(defaultDebugModeFlag()).toBe(true);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("returns false when process.env.NODE_ENV is 'production'", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(defaultDebugModeFlag()).toBe(false);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

// ----------------------------------------------------------------------
// Context construction
// ----------------------------------------------------------------------

describe("buildVerifierContext", () => {
  it("generates a unique runId per call", () => {
    const a = buildVerifierContext({
      logVerifierResults: true,
      disableContractAssertions: false,
    });
    const b = buildVerifierContext({
      logVerifierResults: true,
      disableContractAssertions: false,
    });
    expect(a.runId).not.toBe(b.runId);
    expect(a.runId).toMatch(/^cd_verify_[0-9a-f]+$/);
  });

  it("defaults runContext to customer-app", () => {
    const ctx = buildVerifierContext({
      logVerifierResults: true,
      disableContractAssertions: false,
    });
    expect(ctx.runContext).toBe("customer-app");
  });

  it("accepts runContext override", () => {
    const ctx = buildVerifierContext({
      logVerifierResults: true,
      disableContractAssertions: false,
      runContext: "ci",
    });
    expect(ctx.runContext).toBe("ci");
  });
});
