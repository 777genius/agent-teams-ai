# Phase 0 W6 auth and standalone-artifact characterization

Canonical remediation base: `f7d98790eb868714e536f77bd796072ea706911a`.
V7 starts from the exact independently approved V6 packet and the canonical rejected-gate archive.
Historical producer phase start: `a32f509e6d9bd31ba2135940e336729bf90c3d93`.
Packet narrowing: `phase-00-r3`.

This lane is contract characterization only. It enables no authentication, CORS, remote mutation,
route, cookie, migration, production composition, terminal behavior, or hosted capability.

## Reset and drain contract

The executable model consumes W4's exact ready and drained DTO field names. The drained record binds
`purpose`, `resetGeneration`, `deploymentGeneration`, and `processAnchorGeneration`; mismatch in any
one rejects. Protocol, control-channel provenance, anchor identity, nonce, pidfd/process-group
readiness, classification and empty residuals are also fail-closed.

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

`observed-artifact-scan.json` is the sole standalone-characterization authority. Its emitted rows
come from canonical rejected integration attempt
`a8405fd56102c02a0319e197c5b1b892d612616e39e5e871167cdb42798d5767`; the manifest and evidence
carry only a checked semantic-hash projection. Source characterization does not inspect a mutable
ambient `dist-standalone`, and the focused regression changes an emitted hash to prove stale
authority projections fail closed.

The characterized standalone artifact is rejected for hosted v1. Its graph omits the internal-storage
worker, includes broad Electron/native stubs, copies production dependencies wholesale, and contains
terminal SDK/service surfaces. `proposed-hosted-artifact-manifest.json` therefore records all hosted
readiness claims as false; it is a rejection record, not a production manifest.

Terminal absence remains a v1 rule. The scanner demonstrates that the current artifact violates the
rule, so absence is not claimed achieved. No final hosted image or production composition is proposed
or admitted by this remediation.

## Other current-host characterization

The proxy/origin and cookie models remain negative contract fixtures only. The ABI probe records the
current Node/Electron values and current-host SQLite reopen behavior only. No live edge, browser,
keyring crash schedule, Electron native load, final-image load, or production deployment was run.
