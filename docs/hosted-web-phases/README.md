# Hosted-web execution packets

Current authority is [Phase 03 P3.C0 input repacket](phase-03/README.md), revision
`phase-03-p3-c0-input-repacket-r5`. Start with [START_HERE.md](START_HERE.md) and use
[EXECUTION_INDEX.json](EXECUTION_INDEX.json) as the machine-readable source of truth.

## Current route

Only the zero-code `P3.C0.INPUT_REPACKET` node is active. It may edit exactly seven documentation and
authority paths. It does not authorize product, harness, orchestrator or OpenCode implementation and
does not authorize any process, runtime, terminal, browser or final E2E execution.

The repacket freezes this exact future DAG:

```text
P3.C0.INPUT_REPACKET
  -> parallel OC.PROVENANCE.V1
              + P3.B2.BUILT_ACTUAL_OWNER_ENTRY
              + P3.C.HARNESS_IMPLEMENTATION
  -> P3.C1.EXACT_INPUT_FREEZE
  -> P3.C2.FINAL_NO_FAKE_RUN (exactly one fresh sandbox/test-project run)
  -> P3.RC.INDEPENDENT_ACCEPTANCE
  -> HOLD
```

P3.C execution authority must pass through independently accepted P3.B2, never directly through
P3.B. `P3.F.COORDINATED_ACTIVATION` remains controller-only and unmaterialized.

## Independent identities

The packet/future-harness base is `720fc62768341e1c2960cfaf4ad2496dd008291e` (tree
`d055bb5c362082a3b721d04ff1c44d8711d8d208`). The exact audited runtime source is the distinct
historical commit `d71671599c062244767494d392575cfacba5e1ff` (tree
`af7fa38ec50893550ce14026c39b428f8dbfd1f2`). The future reviewed harness implementation/final-run
commit is unset and unavailable; a controller may inject it only after independent review.

Accepted orchestrator PR #44 source `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7` is the P3.B base for
P3.B2. It is not itself an accepted runnable built actual-owner entry. P3.B2 must provide a new exact
result commit, fixed built-entry identity and complete reproducible build/toolchain recipe before
P3.C1 can freeze inputs.

OpenCode keeps every identity layer separate:

- PR head `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f`;
- workflow merge `2cbaa3f8d7f130ba41f07aab114a76f08cc311f1`;
- release source `3186244c3103eb02d95a255b593847b14488b070`, tree
  `8fba45aecd63ec61f334a856694cbd3da037df90`, base
  `47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7`;
- run `32784750815`, attempt `1`, ref `refs/pull/4/merge`, artifact `9541196940`;
- Actions ZIP `601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c`;
- release manifest `076dd096b36e34c47ad789c7b492d6b510f9b89cca9e6604f6fd0431c02d99fd`;
- Linux x64 tar `fb1a48abaa25c412134c684f2c5b7ffa4fafd16d68c717fe0ede3ee655123308`;
  and
- Linux x64 binary `4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e`.

## Provenance and proof boundary

Product policy requires the exact audited runtime-source descriptor plus a clean controller-bound
reviewed harness worktree, pinned toolchain and fresh isolated build. Orchestrator policy requires a
fresh isolated build from an independently accepted P3.B2 result; current P3.B source/build status is
not a runnable-artifact claim. OpenCode policy admits only an immutable receipt and exact digest
binding for a future sandbox behavior run. The receipt and release manifest are not signed build
attestations.

The current OpenCode candidate has no signed build attestation. `unsignedProvenanceAccepted=false`,
`productionEligible=false`, and `releaseEligible=false`. Signed provenance remains required for any
production or release decision, but that policy is outside `productionGates`; every actual activation
boolean there is false.

Any future run uses one new marker-owned sandbox/test project, never a real project runtime or
terminal. Pass/fail derives from raw HTTP/SSE, built-owner WAL/journal, OpenCode effect and supervisor
records joined to the controller nonce and verified process starts. Ambiguous external effects become
`operator_required` and are never automatically retried.

This packet performs no final E2E and no production enablement. No worker may materialize P3.F or
launch a successor. End `HOLD`.
