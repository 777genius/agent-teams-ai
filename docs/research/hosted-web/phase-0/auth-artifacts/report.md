# Phase 0 W6 auth and standalone-artifact characterization

Canonical current-commit source: `42ec333848e29e97c41699b9fed73ed199740e3f`.
Historical rejected-candidate provenance is retained separately and is not current-commit authority.
Historical producer phase start: `a32f509e6d9bd31ba2135940e336729bf90c3d93`.
Packet narrowing: `phase-00-r3`.

This lane is contract characterization only. It enables no authentication, CORS, remote mutation,
route, cookie, migration, production composition, terminal behavior, or hosted capability.

## Reset and drain contract

The executable model directly consumes controller envelope
`P0.CONTROLLER.W4_W6.DRAIN_EVIDENCE_ENVELOPE.V1`, pinned to
`docs/research/hosted-web/phase-0/w4-w6-contract/drain-evidence-envelope.schema.json` and its
SHA-256. It accepts only the envelope's exact ready and drained objects and never adds a W6-owned
source or authority wrapper. The drained record binds `purpose`, `resetGeneration`,
`deploymentGeneration`, and `processAnchorGeneration`; mismatch in any field rejects. Protocol,
anchor identity, nonce, pidfd/process-group readiness, classification and empty residuals are also
fail-closed.

While `resetIntent` exists, bootstrap, pair and renew reject with `reset_in_progress`. Restart and all
remaining transitions preserve `mutationAdmission=false` at every durable reset stage. These are
fixture-characterized invariants, not remote-auth or remote-mutation readiness.

## One controller-owned artifact authority

The controller-owned source is
`docs/research/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.json`, with its adjacent
schema. W4 and W6 load that exact path and SHA-256 and expose equal read-only projections. The
cross-lane suite rejects a missing artifact, extra artifact, renamed field, stale path, and stale
protocol hash. Neither lane owns a competing path or hash table.

## Standalone disposition and terminal rule

`observed-artifact-scan.json` is the sole exact current-commit standalone-characterization authority.
Its seven emitted CJS rows come from the configured targeted Vite build of canonical source commit
`42ec333848e29e97c41699b9fed73ed199740e3f` into an ephemeral directory. The verifier performs that
targeted build again and compares the complete record, including every relative path, byte count and
SHA-256. It never accepts a mutable ambient `dist-standalone` as evidence.

`historical-rejected-candidate-artifact-scan.json` separately preserves the rows and provenance from
rejected integration attempt `a8405fd56102c02a0319e197c5b1b892d612616e39e5e871167cdb42798d5767`.
That record is historical contradiction evidence only. The manifest and current evidence project the
semantic hash of `observed-artifact-scan.json`; changing a current emitted hash fails closed.

The characterized standalone artifact is rejected for hosted v1. Its graph omits the internal-storage
worker, includes broad Electron/native stubs, copies production dependencies wholesale, and contains
terminal SDK/service surfaces. `proposed-hosted-artifact-manifest.json` therefore records all hosted
readiness claims as false; it is a rejection record, not a production manifest.

Terminal exclusion remains a v1 rule. The targeted current-commit build demonstrates that the current
artifact violates the rule, so exclusion is not claimed achieved. No final hosted image or production
composition is proposed or admitted by this remediation.

The estimate assumption is deliberately narrower than an artifact-admission claim: the existing
standalone source/build path may evolve in place, but evolution is unproved. The exact canonical
artifact above remains rejected, and any evolved candidate requires its own reviewed packet.

## Other current-host characterization

Artifact inventory and current terminal-rule evaluation are
`targeted_current_commit_build_observed`. Proxy/origin, auth transitions and ABI behavior remain
fixture/current-host characterization at their declared levels. No live edge, browser, keyring crash
schedule, Electron native load, final-image load, or production deployment was run.

## Target-image gate: accepted Phase 0 capability narrowing

The immutable source for this decision is commit
`42ec333848e29e97c41699b9fed73ed199740e3f`, tree
`4bc04a743c20ea48e06ada55c761d03881117cac`. That source is separate from the
repository commit that later adopts this evidence. Verification requires the adopting HEAD to be the
source or its descendant and reports that mutable evidence identity separately; it never rewrites the
source identity inside the decision.

Decision `P0.D.TARGET_IMAGE` is `accepted` with outcome `capability_narrowed`. Phase 0 closes its
target-image gate by preserving the complete admission contract and all known gaps, not by claiming
that a final image already exists. Phase 5 owns the production composition, build graph, native
artifacts, hardened profile and in-image probes, so exact-image admission before Phase 5 would be
circular. No hosted route, mutation, provider runtime, credential canary, production composition or
terminal-negative image readiness is enabled by this decision.

The deterministic canonical-source evaluation remains fail closed with exactly 51 obligations: 21
composition, four image identity, three inventory, 12 runtime profile, two provider-runtime and nine
terminal-negative scan obligations. The current standalone candidate is not a substitute and retains
four observed terminal-absence violations. Terminal absence is still mandatory over capabilities,
files, migrations, packages, ports, processes, renderer chunks, routes and volumes.

The Phase 5 gate must remain closed until one reviewed immutable target-image manifest/profile is
instantiated and supplies digest-bound complete inventory, native binary/builder/compiler and
ownership/mode provenance, init/lock/anchor-before-Node ordering, target-executed provider canaries
bound to the same digest, and negative terminal scans over every named surface. The same gate blocks
Phase 5 route admission and capability advertisement and Phase 6 non-loopback mutations.

Live Docker state is intentionally absent from deterministic decision facts. Phase 0 verification
does not invoke or assume a Docker CLI, daemon or socket. Synthetic provider canaries check only
redaction and cross-provider isolation in the admission harness; they remain explicitly below
target-image provider execution. No real project or credential is used.
