# Phase 03: P3.C0 actual-owner input repacket

- Status: `active / zero-code input repacket only`
- Packet revision: `phase-03-p3-c0-input-repacket-r5`
- Current node: `P3.C0.INPUT_REPACKET`
- Packet/base commit: `720fc62768341e1c2960cfaf4ad2496dd008291e`
- Terminal state: `HOLD`

## Outcome

Correct and independently review the seven-file authority packet before any successor is launched.
This node freezes identity roles, component-specific provenance policies, P3.B2 admission, successor
interfaces and the exact future DAG. It creates no implementation, launches no runtime or terminal,
runs no final E2E and changes no production state.

## Exact identity record

The product identities are deliberately independent:

- packet and future harness base `720fc62768341e1c2960cfaf4ad2496dd008291e`, tree
  `d055bb5c362082a3b721d04ff1c44d8711d8d208`;
- audited exact runtime source `d71671599c062244767494d392575cfacba5e1ff`, tree
  `af7fa38ec50893550ce14026c39b428f8dbfd1f2`, resolved from repository history; and
- future independently reviewed harness result and controller-injected final-run commit, both unset
  and unavailable now.

P3.B accepted exact orchestrator PR #44 source
`06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7`. That source tree and its green build history do not
constitute a runnable accepted built actual-owner artifact. The future P3.B2 node must add and
independently accept a fixed built entry plus exact closure/build/toolchain identities. P3.C input
freeze and execution depend on P3.B2, never directly on P3.B.

The exact OpenCode bindings are separate:

| Role | Exact identity |
| --- | --- |
| PR head | `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f` |
| Workflow merge | `2cbaa3f8d7f130ba41f07aab114a76f08cc311f1` |
| Release source / tree / base | `3186244c3103eb02d95a255b593847b14488b070` / `8fba45aecd63ec61f334a856694cbd3da037df90` / `47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7` |
| Workflow | run `32784750815`, attempt `1`, ref `refs/pull/4/merge` |
| Artifact | `9541196940` |
| Actions ZIP SHA-256 | `601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c` |
| Release manifest SHA-256 | `076dd096b36e34c47ad789c7b492d6b510f9b89cca9e6604f6fd0431c02d99fd` |
| Linux x64 tar SHA-256 | `fb1a48abaa25c412134c684f2c5b7ffa4fafd16d68c717fe0ede3ee655123308` |
| Linux x64 binary SHA-256 | `4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e` |

## Provenance policies

- Product runtime: preserve the exact audited runtime descriptor; the final controller-bound reviewed
  harness worktree must match it and use a pinned toolchain plus a fresh isolated build.
- Orchestrator: build only from a future independently accepted exact P3.B2 result and recipe. P3.B
  source and either `cli-source` file are not final-run built-entry identities.
- OpenCode: an immutable acquisition receipt and release-manifest/archive/binary digests may bind a
  future sandbox behavior candidate. They do not prove a signed build. The current candidate has no
  signed build attestation, `unsignedProvenanceAccepted=false`, `productionEligible=false`, and
  `releaseEligible=false`.

Signed provenance remains required for production or release. That requirement is policy outside the
all-false production activation gates.

## Exact DAG

After independent adoption, P3.C0 may fan out only through new controller packets to parallel
`OC.PROVENANCE.V1`, `P3.B2.BUILT_ACTUAL_OWNER_ENTRY`, and `P3.C.HARNESS_IMPLEMENTATION`. All three
must be independently accepted before `P3.C1.EXACT_INPUT_FREEZE`. P3.C1 alone may feed
`P3.C2.FINAL_NO_FAKE_RUN`, which permits exactly one new marker-owned sandbox/test-project run. Its
retained evidence then goes to `P3.RC.INDEPENDENT_ACCEPTANCE`, and the route ends `HOLD`.

`P3.F.COORDINATED_ACTIVATION` is controller-only and remains unmaterialized. See
[controller-packet.md](controller-packet.md), [execution-dag.md](execution-dag.md), and the
[P3.C0/future no-fake lane](lanes/p3-c-no-fake-e2e.md).

## Safety

Real projects may not be used or opened in a runtime or terminal. This task performs no final E2E,
provider effect, production enablement or successor launch. A future P3.C2 run must derive truth from
raw HTTP/SSE, built-owner WAL/journal, OpenCode effect and supervisor records joined to exact process
starts. An ambiguous external effect becomes durable `operator_required` and is never automatically
retried.
