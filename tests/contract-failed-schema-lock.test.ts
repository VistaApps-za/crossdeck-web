/**
 * Schema-lock test for `crossdeck.contract_failed`.
 *
 * The Web SDK's reportContractFailure(...) must:
 *   1. Send a payload whose keys are exactly the allowed-fields set
 *      (required ∪ optional) from
 *      contracts/diagnostics/contract-failed-payload-schema-lock.json.
 *   2. NEVER go through the customer's track() pipeline — the
 *      reliability telemetry is single-fire to a dedicated endpoint
 *      hardcoded in _diagnostic-telemetry.ts.
 *   3. NEVER include any forbidden field even if the caller's input
 *      were to carry one.
 *
 * The schema-lock contract is the structural defence behind the
 * independent-controller flow in Privacy Policy §6 — these tests
 * fail loudly the moment the wire shape drifts.
 */

import { describe, it, expect } from "vitest";
import {
  DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS,
  DIAGNOSTIC_TELEMETRY_ENDPOINT,
  filterDiagnosticPayload,
} from "../src/_diagnostic-telemetry";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const contract = require("../../../contracts/diagnostics/contract-failed-payload-schema-lock.json");

describe("contract-failed schema-lock — Web", () => {
  describe("DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS mirrors the contract", () => {
    it("matches required ∪ optional from contracts/diagnostics/contract-failed-payload-schema-lock.json", () => {
      const fromContract = new Set<string>([
        ...contract.allowedFields.required,
        ...contract.allowedFields.optional,
      ]);
      expect(new Set(DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS)).toEqual(fromContract);
    });

    it("does not contain any forbidden field", () => {
      for (const forbidden of contract.allowedFields.forbidden) {
        expect(DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS.has(forbidden)).toBe(false);
      }
    });
  });

  describe("reportContractFailure payload conforms to schema-lock", () => {
    it("strips every forbidden field from the payload before send", () => {
      // filterDiagnosticPayload is what runs immediately before the
      // network IO — verifying its behaviour is what protects the
      // independent-controller legitimate-interest basis.
      const filtered = filterDiagnosticPayload({
        contract_id: "test-contract",
        sdk_version: "1.0.0",
        sdk_platform: "web",
        failure_reason: "test failure",
        run_context: "ci",
        run_id: "run_123",
        // Forbidden — must be stripped.
        anonymousId: "anon_12345",
        ip: "1.2.3.4",
        email: "user@example.com",
        stack_trace: "Error\n  at foo (bar.js:1:1)",
        user_agent: "Mozilla/5.0",
        session_id: "sess_abc",
      } as Record<string, string>);

      for (const forbidden of contract.allowedFields.forbidden) {
        expect(filtered).not.toHaveProperty(forbidden);
      }
      // And the required fields are preserved.
      for (const required of contract.allowedFields.required) {
        expect(filtered).toHaveProperty(required);
      }
    });

    it("preserves optional fields when present", () => {
      const filtered = filterDiagnosticPayload({
        contract_id: "test-contract",
        sdk_version: "1.0.0",
        sdk_platform: "web",
        failure_reason: "test failure",
        run_context: "ci",
        run_id: "run_123",
        test_file: "tests/foo.test.ts",
        test_name: "fails when X",
        device_class: "desktop",
        verification_phase: "hot_path",
      });
      expect(filtered.test_file).toBe("tests/foo.test.ts");
      expect(filtered.test_name).toBe("fails when X");
      expect(filtered.device_class).toBe("desktop");
      expect(filtered.verification_phase).toBe("hot_path");
    });

    it("verification_phase is in the schema-lock optional set", () => {
      expect(contract.allowedFields.optional).toContain("verification_phase");
    });

    it("does not enter customer track pipeline", () => {
      // Defensive: the endpoint URL is hardcoded to the reliability
      // path. If anyone changes _diagnostic-telemetry to point at the
      // customer events pipeline, this test fails.
      expect(DIAGNOSTIC_TELEMETRY_ENDPOINT).toBe(
        "https://api.cross-deck.com/v1/sdk/diagnostic",
      );
      expect(DIAGNOSTIC_TELEMETRY_ENDPOINT).not.toContain("/v1/events");
    });
  });
});
