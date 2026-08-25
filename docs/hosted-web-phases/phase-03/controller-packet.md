# Phase 03 controller packet: P3.C0 input repacket

## Status and authority

- Status: `active-zero-code-input-repacket`.
- Packet revision: `phase-03-p3-c0-input-repacket-r5`.
- Current node: `P3.C0.INPUT_REPACKET`.
- Packet/base commit: `720fc62768341e1c2960cfaf4ad2496dd008291e`.
- Product PR: `777genius/agent-teams-ai#252`.
- Orchestrator PR: `777genius/agent_teams_orchestrator#44`.
- OpenCode candidate: `777genius/opencode-anomaly#4`.
- Terminal state: `HOLD` for every node.

The controller may admit only the seven-file P3.C0 documentation repacket. Implementation, runtime,
terminal, browser, provider effects, a final E2E, review acceptance, production/release eligibility,
P3.F materialization and every successor launch are unauthorized now.

## Exact independent identity record

| Component/role | Exact identity | Current disposition |
| --- | --- | --- |
| Packet and future harness base | commit `720fc62768341e1c2960cfaf4ad2496dd008291e`; tree `d055bb5c362082a3b721d04ff1c44d8711d8d208` | exact P3.C0 audit/base identity only |
| Product runtime source | commit `d71671599c062244767494d392575cfacba5e1ff`; tree `af7fa38ec50893550ce14026c39b428f8dbfd1f2` | repository-history-resolved P3.A/P3.RA runtime descriptor; not packet or harness identity |
| Harness implementation/final run | base `720fc62768341e1c2960cfaf4ad2496dd008291e`; result and controller-injected final-run commits unset | unavailable and unreviewed |
| P3.B orchestrator source | `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7` | exact accepted source base; not an accepted runnable built artifact |
| P3.B2 built entry | future exact result commit, fixed entry digest, closure identity and recipe | all unset; independent acceptance required |
| OpenCode PR head | `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f` | source-review identity only |
| OpenCode workflow merge | `2cbaa3f8d7f130ba41f07aab114a76f08cc311f1` | run/acquisition identity; not PR head or release source |
| OpenCode release | source `3186244c3103eb02d95a255b593847b14488b070`; tree `8fba45aecd63ec61f334a856694cbd3da037df90`; base `47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7` | release-manifest source identities |
| OpenCode workflow/artifact | run `32784750815`; attempt `1`; ref `refs/pull/4/merge`; artifact `9541196940` | immutable acquisition facts |
| OpenCode Actions ZIP | SHA-256 `601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c` | artifact envelope |
| OpenCode release manifest | SHA-256 `076dd096b36e34c47ad789c7b492d6b510f9b89cca9e6604f6fd0431c02d99fd` | digest metadata, not attestation |
| OpenCode Linux x64 tar | SHA-256 `fb1a48abaa25c412134c684f2c5b7ffa4fafd16d68c717fe0ede3ee655123308` | nested platform archive |
| OpenCode Linux x64 binary | SHA-256 `4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e` | executable bytes |

No identity in one row may substitute for an identity in another. Missing, prefix-only, collapsed or
contradictory fields fail closed.

## Component-specific provenance policy

### Product runtime

The exact runtime-source descriptor is commit `d71671599c062244767494d392575cfacba5e1ff`, tree
`af7fa38ec50893550ce14026c39b428f8dbfd1f2`. A future final-run descriptor must also name the
independently reviewed controller-injected harness commit, prove that the audited runtime-source bytes
still match, bind a clean exact worktree and pinned toolchain, and describe a fresh isolated product
build. No build or final harness commit is available now.

### Orchestrator

P3.B source `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7` is only the exact base for
`P3.B2.BUILT_ACTUAL_OWNER_ENTRY`. Current source files, historical build-green status, the generic
`cli-source`, and the actual-owner `cli-source` do not constitute a runnable accepted built artifact.
P3.B2 must add a fixed built acceptance entry and supply an independently accepted exact result commit,
entry/closure digests, pinned Bun/toolchain identities, offline dependency identity and complete fresh
build recipe. P3.C1 and P3.C2 may consume P3.B2 only; direct P3.B execution is forbidden.

### OpenCode

`OC.PROVENANCE.V1` must materialize immutable receipt, manifest, archive-layer and executable facts
without collapsing them or manufacturing a signature claim. The receipt and digest equality may
admit only exact sandbox behavior bytes after P3.C1; neither is signed build provenance. The current
candidate has no signed build attestation. Therefore `unsignedProvenanceAccepted=false`,
`productionEligible=false`, `releaseEligible=false`, and the candidate cannot supersede the production
lock.

Signed provenance remains required before any production or release decision. This requirement is
policy outside `productionGates`; every activation boolean in that object remains false.

## Exact dependency DAG

P3.C0 freezes schemas and successor interfaces. Only after independent adoption may the controller
materialize these three successor packets in parallel:

1. `OC.PROVENANCE.V1`;
2. `P3.B2.BUILT_ACTUAL_OWNER_ENTRY`, based on accepted P3.B source; and
3. `P3.C.HARNESS_IMPLEMENTATION`, based on
   `720fc62768341e1c2960cfaf4ad2496dd008291e`.

All three independently accepted results are conjunctive inputs to `P3.C1.EXACT_INPUT_FREEZE`. P3.C1
must freeze exact commits, toolchains, recipes, canonical paths, modes, sizes and hashes before any
launch authority exists. It may then feed `P3.C2.FINAL_NO_FAKE_RUN`, which authorizes exactly one
fresh marker-owned sandbox/test-project run. Retained evidence goes to
`P3.RC.INDEPENDENT_ACCEPTANCE`; the edge then ends `HOLD`.

`P3.F.COORDINATED_ACTIVATION` has no materialized packet or edge. Only the controller may later create
it under new authority; no worker output may do so.

## Future P3.C1 ready conditions

All conditions are conjunctive and none is satisfied now:

1. P3.C0 has independent acceptance at the exact packet/base commit.
2. `OC.PROVENANCE.V1` has accepted exact separate receipt, manifest, archive and binary identities,
   including the explicit absent-attestation/false-eligibility state.
3. P3.B2 has an independently accepted exact result commit, fixed built actual-owner entry, complete
   isolated closure and exact build/toolchain recipe. P3.B alone cannot satisfy this row.
4. The product harness has an independently reviewed exact result commit; the controller has not yet
   injected it as the final-run commit.
5. The product runtime source still matches the audited exact descriptor, and the final product
   worktree/build/toolchain descriptor is clean, pinned and fresh.
6. All canonical inputs are private, anchored, non-symlink, single-link where required, mutually
   disjoint and digest-matched.
7. Every production, completion and successor activation gate remains false.

## Future evidence and safety boundary

P3.C2, if later materialized, uses exactly one new private marker-owned sandbox/test project and one
disjoint evidence root. It may never open a real project in a runtime or terminal and may expose no
ambient provider identity/data, auth, home or shared state. It binds each process to a pidfd or verified
`/proc` start time, never a bare PID.

Behavioral acceptance comes only from retained raw product HTTP/SSE, built-owner WAL/journal,
OpenCode request/effect/response and supervisor spawn/ready/restart/exit/drain records, all joined to
the controller nonce and process starts. Fixtures, reports, screenshots and summaries are indexes only.

A timeout or lost response across the provider boundary becomes durable `operator_required` with a
stable `reconciliationRef`. Ordinary delivery never automatically retries it. Explicit `delivered`
closes without another effect; only explicit `not_delivered` may authorize one new fenced attempt.

## Current ownership and stop conditions

Only the seven documentation/authority paths listed by `activeLane.ownedPaths` in
[EXECUTION_INDEX.json](../EXECUTION_INDEX.json) are writable for P3.C0. No source, runtime, test,
dependency, lockfile, CI/workflow, production lock, release metadata or other repository may change.

Stop `HOLD` on any out-of-scope path, unresolved full SHA, identity collapse, direct P3.B-to-P3.C
dependency, built-artifact claim for current P3.B source, true production gate, runtime/terminal/final
E2E attempt, real-project contact, production enablement, automatic ambiguous-effect retry, P3.F
materialization or successor launch.
