# Hosted-web execution packets

Current authority is [Phase 03 actual-owner closure](phase-03/README.md), revision
`phase-03-actual-owner-closure-r3`. Start with [START_HERE.md](START_HERE.md) and use
[EXECUTION_INDEX.json](EXECUTION_INDEX.json) as the machine-readable source of truth.

## Current route

Phase 03 closes one remaining Hosted Core v1 boundary without broadening scope:

1. preserve accepted product P3.A/P3.RA at
   `d71671599c062244767494d392575cfacba5e1ff` and accepted orchestrator P3.B at
   `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7` as immutable predecessors;
2. implement and run the bounded P3.C activation-v2 no-fake harness against runner-executed fresh
   isolated builds from exact clean product/orchestrator commits and the declared sandbox-only
   OpenCode candidate;
3. prove the complete actual-owner path and negative/recovery matrix in exactly one new marker-owned
   sandbox project, without a real provider identity or ReviewRouter; and
4. leave every production and successor gate false pending independent review and a newly
   materialized coordinated-activation packet.

P3.C completion acceptance is also false: a producer's `verified` handoff still ends `HOLD` and
cannot substitute for the required independent P0/P1/P2 `0/0/0` review.

The current authorized node is only `P3.C.NO_FAKE_E2E`. Revision r3 authorizes only the 11 future
implementation paths listed in the execution index. This packet change launches no runtime and ends
`HOLD`; it does not authorize P3.F, production activation, a production lock change, or a successor.
In particular, the declared future `run.ts` is not present or executable in this documentation-only
packet.

The future runner accepts only controller-owned versioned commit-scoped product and orchestrator
recipe IDs defined in `run.ts`; caller-supplied build argv, executables, outputs and closure roots are
forbidden. Recipes pin executable/toolchain/lockfile identities, sanitize an allowlisted environment,
run ordered direct argv steps without a shell, and substitute only controller-owned private absolute
roots. The product recipe implements the exact two-step standalone build and closes `out/renderer`,
`dist-standalone`, root package metadata and the complete Docker production dependency tree. The
orchestrator recipe directly runs the accepted Bun build and closes the tracked `cli` wrapper plus
all of `dist/local-cli`.

Every output/closure root starts absent. Every regular closure file is walked descriptor-relatively
with `O_NOFOLLOW`, `nlink=1`, stable before/after `fstat`, and the same open descriptor for hash and
copy. Complete sorted normalized manifests produce deterministic manifest and Merkle digests and
reject missing, extra or undeclared output. Accepted HEAD and tracked source/index are revalidated
after build and immediately before staging. OpenCode comes only from private canonical ZIP,
immutable signed attestation and immutable manifest paths; all five immutable pins and attested
digests are verified before secure extraction into a private empty root, with no network re-download.

## Authority and evidence

Every worker starts from the exact immutable phase SHA injected by `ProjectScopedControl`, edits only
the lane packet's explicit paths, runs the declared checks, self-reviews, and returns `HOLD`.
Successor nodes require a new controller decision; worker output alone never authorizes integration,
E2E, or gate activation.

The current production OpenCode runtime lock remains authoritative and unchanged. PR #4 commit
`fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f`, workflow run `32784750815`, artifact `9541196940`, ZIP
SHA-256 `601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c`, and Linux x64 SHA-256
`4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e` form a sandbox-only
candidate with `productionEligible=false`. It does not supersede the production lock and cannot
activate production.

The runtime owns execution primitives only. The controller owns DAG admission, dependencies, review,
drift invalidation, integration, and promotion. Historical Phase 01/02 packets remain preserved but
are not current launch authority.
