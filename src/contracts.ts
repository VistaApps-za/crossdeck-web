/**
 * Public, typed accessor for the bank-grade behavioural contracts
 * this SDK ships. The full architecture — schema, distribution,
 * audit loop, pillar taxonomy — lives in `contracts/README.md`
 * at the monorepo root.
 *
 * Why a typed surface (vs. plain JSON access): contract IDs and
 * pillar names are part of Crossdeck's public commitment to
 * customers. Reading them through `CrossdeckContracts` means the
 * compiler catches drift the moment a contract is renamed or
 * retired. Tools that consume contracts at runtime (dashboards,
 * AI assistants, customer integration tests) get the exact same
 * shape every SDK ships, with no parsing layer to drift.
 *
 * --- BINARY STABILITY ---
 * `Contract` is treated as an evolving — but back-compat — wire
 * shape. Fields may be added in any minor release. Existing
 * fields will not be removed or repurposed except in a major
 * version bump, even if all known contracts stop using them.
 * Customers can rely on `id`, `pillar`, `status`, `appliesTo`,
 * `codeRef`, `testRef`, `registeredAt`, `firstRegisteredIn`,
 * and `bundledIn` being present on every contract in every
 * future minor/patch release of this SDK.
 */

import {
  BUNDLED_CONTRACTS,
  BUNDLED_IN,
  SDK_VERSION,
} from "./_contracts-bundled";

/**
 * Which bank-grade pillar a contract belongs to. The taxonomy is
 * deliberately small — every contract maps to exactly one. New
 * pillars require a Crossdeck major-version bump.
 */
export type ContractPillar =
  | "revenue"
  | "entitlements"
  | "analytics"
  | "webhooks"
  | "errors"
  | "lifecycle"
  | "identity";

/**
 * Lifecycle stage of a contract.
 * - `enforced`: live in this SDK and exercised by `testRef`.
 * - `proposed`: registered for an upcoming release; `testRef`
 *    may point to a not-yet-existing file.
 * - `retired`: kept for history only; the behaviour no longer
 *    ships. Filtered out of `CrossdeckContracts.all()` by default.
 */
export type ContractStatus = "enforced" | "proposed" | "retired";

/** Which SDKs (and/or `backend`) a contract is binding on. */
export type ContractAppliesTo =
  | "web"
  | "node"
  | "react-native"
  | "swift"
  | "android"
  | "backend";

/**
 * Pointer to the test that exercises a contract clause. The
 * `name` is matched verbatim against the file's text by
 * `scripts/contract-audit.mjs`, so a rename without updating
 * the contract aborts CI.
 */
export interface ContractTestRef {
  readonly file: string;
  readonly name: string;
}

/** One bank-grade behavioural guarantee — see `contracts/README.md`. */
export interface Contract {
  readonly id: string;
  readonly pillar: ContractPillar;
  readonly status: ContractStatus;
  readonly claim: string;
  readonly appliesTo: readonly ContractAppliesTo[];
  readonly codeRef: readonly string[];
  readonly testRef: readonly ContractTestRef[];
  /** ISO-8601 date the contract was first registered. */
  readonly registeredAt: string;
  /** The release note / phase the contract first appeared in. Immutable. */
  readonly firstRegisteredIn: string;
  /** The SDK release this snapshot was bundled with, stamped at build time. */
  readonly bundledIn: string;
  /**
   * Whether THIS SDK self-verifies this contract at runtime (a verifier is
   * registered in the SDK's `STATIC_VERIFIERS` harness, emitting
   * `crossdeck.contract_failed` live), vs. proven by CI tests only.
   *
   * DERIVED at bundle time from the verifier registry — never hand-set —
   * so the registry can never disagree with what actually runs. Runtime
   * status is a property of (contract × SDK): the same contract can be
   * `true` here (web) and `false` in another SDK that lacks the harness.
   *
   * `true`  → surfaces in the console as "watch it pass live".
   * `false` → "CI-proven every release" (still enforced, just not a
   *           live toggle on this platform).
   */
  readonly runtimeVerified: boolean;
}

/**
 * Typed entry point to the bank-grade contracts bundled with this
 * SDK release. Stable, side-effect-free, tree-shakeable.
 *
 * @example Audit at app boot
 * ```ts
 * import { CrossdeckContracts } from "@cross-deck/web";
 *
 * for (const c of CrossdeckContracts.all()) {
 *   console.log(`[crossdeck] ${c.id} (${c.pillar})`);
 * }
 * ```
 *
 * @example Assert a specific clause is in force
 * ```ts
 * const isolation = CrossdeckContracts.byId("per-user-cache-isolation");
 * if (!isolation || isolation.status !== "enforced") {
 *   throw new Error("entitlement isolation contract is not enforced — refusing to start");
 * }
 * ```
 */
export const CrossdeckContracts = {
  /** Every contract that applies to this SDK and is currently enforced. */
  all(): readonly Contract[] {
    return BUNDLED_CONTRACTS.filter((c) => c.status === "enforced");
  },

  /**
   * Every contract bundled with this SDK release, including
   * `proposed` and `retired` entries. Use `all()` for the
   * enforced-only view.
   */
  allIncludingHistorical(): readonly Contract[] {
    return BUNDLED_CONTRACTS;
  },

  /** Look up a contract by its stable `id`. */
  byId(id: string): Contract | undefined {
    return BUNDLED_CONTRACTS.find((c) => c.id === id);
  },

  /** Every enforced contract within a pillar. */
  byPillar(pillar: ContractPillar): readonly Contract[] {
    return BUNDLED_CONTRACTS.filter(
      (c) => c.pillar === pillar && c.status === "enforced",
    );
  },

  /** Filter by lifecycle status. */
  withStatus(status: ContractStatus): readonly Contract[] {
    return BUNDLED_CONTRACTS.filter((c) => c.status === status);
  },

  /** Semver of the SDK release these contracts were bundled with. */
  sdkVersion: SDK_VERSION,

  /** Fully-qualified bundle identifier — e.g. `@cross-deck/web@1.4.2`. */
  bundledIn: BUNDLED_IN,

  /**
   * Resolve a failing test back to the contract it exercises.
   * Used by test-framework hooks (Vitest `afterEach`, XCTest
   * observation, JUnit `TestWatcher`) to find the contract id of
   * a failed contract test so `reportContractFailure(...)` can
   * stamp the right `contract_id` on the emitted event.
   *
   * Match is on `testRef.name` (case-sensitive, exact). Returns
   * the first contract whose `testRef` list contains a matching
   * entry, regardless of pillar or status.
   */
  findByTestName(name: string): Contract | undefined {
    return BUNDLED_CONTRACTS.find((c) =>
      c.testRef.some((ref) => ref.name === name),
    );
  },
} as const;

/**
 * Input to {@link Crossdeck.reportContractFailure}. Lets a test
 * harness / dogfood app / customer integration report a contract
 * violation back to Crossdeck on the dedicated reliability channel —
 * single-fire, never visible in the customer's dashboard.
 *
 * SCHEMA-LOCK: this interface's field set is exhaustively named. No
 * free-form `extra: Record<string, unknown>` — the schema-lock
 * contract at
 * `contracts/diagnostics/contract-failed-payload-schema-lock.json`
 * forbids unbounded fields. Adding a field requires a PR that
 * amends the contract first, then the public interface.
 *
 * `sdk_version` and `sdk_platform` are auto-stamped by the SDK so
 * every emitted event carries them correctly without the caller
 * needing to read them out of `CrossdeckContracts.sdkVersion`.
 */
export interface ContractFailureInput {
  /** Stable contract id (`per-user-cache-isolation` etc.). */
  contractId: string;
  /**
   * Short categorical-ish label — the SDK convention is to keep this
   * under 128 chars and stable across runs (so dashboards can group).
   * Never an end-user-supplied string.
   */
  failureReason: string;
  /**
   * Where the failure was observed:
   *   - `ci`            — the SDK's own test suite on CI
   *   - `dogfood`       — Crossdeck's internal dogfood project
   *   - `customer-app`  — a customer's app verifying contracts
   */
  runContext: "ci" | "dogfood" | "customer-app";
  /**
   * Stable identifier for this verification run. CI: `GITHUB_RUN_ID`
   * or equivalent. Dogfood: per-launch UUID. Customer app: any
   * stable handle the customer chooses to group fires by run.
   */
  runId: string;
  /**
   * Optional pointer back to the failing test, for triage. The SDK
   * sends both `test_file` and `test_name` on the wire when set.
   */
  testRef?: { file: string; name: string };
  /**
   * Optional coarse device class, e.g. "desktop", "mobile-web",
   * "ssr". A categorical bucket, not a device identifier.
   */
  deviceClass?: string;
}
