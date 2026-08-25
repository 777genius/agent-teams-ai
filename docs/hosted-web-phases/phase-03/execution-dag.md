# Phase 03 execution DAG

Status: `active at P3.C0.INPUT_REPACKET only`; packet revision:
`phase-03-p3-c0-input-repacket-r5`; terminal state: `HOLD`.

```text
P3.C0.INPUT_REPACKET                    active zero-code seven-file authority correction
          |
          +-------------------------------+--------------------------------+
          |                               |                                |
          v                               v                                v
OC.PROVENANCE.V1             P3.B2.BUILT_ACTUAL_OWNER_ENTRY    P3.C.HARNESS_IMPLEMENTATION
receipt/digest/provenance    built exact successor to P3.B     exact result commit initially unset
state; no signature claim    source base; independent review   independent deterministic review
          |                               |                                |
          +-------------------------------+--------------------------------+
                                          |
                                          v
                              P3.C1.EXACT_INPUT_FREEZE
                              exact accepted commits, recipes,
                              toolchains, paths, modes, sizes and hashes
                                          |
                                          v
                              P3.C2.FINAL_NO_FAKE_RUN
                              exactly one fresh marker-owned
                              sandbox/test-project execution
                                          |
                                          v
                              P3.RC.INDEPENDENT_ACCEPTANCE
                                          |
                                          v
                                        HOLD
```

This edge list is exhaustive:

1. `P3.C0.INPUT_REPACKET -> OC.PROVENANCE.V1`;
2. `P3.C0.INPUT_REPACKET -> P3.B2.BUILT_ACTUAL_OWNER_ENTRY`;
3. `P3.C0.INPUT_REPACKET -> P3.C.HARNESS_IMPLEMENTATION`;
4. each of those three parallel nodes `-> P3.C1.EXACT_INPUT_FREEZE`;
5. `P3.C1.EXACT_INPUT_FREEZE -> P3.C2.FINAL_NO_FAKE_RUN`;
6. `P3.C2.FINAL_NO_FAKE_RUN -> P3.RC.INDEPENDENT_ACCEPTANCE`; and
7. `P3.RC.INDEPENDENT_ACCEPTANCE -> HOLD`.

`P3.F.COORDINATED_ACTIVATION` is controller-only and unmaterialized. It has no current edge. P3.C0
does not launch its parallel successors; a controller must first adopt this repacket and issue new
exact packets.

## Identity and dependency invariants

The product packet/future-harness base is
`720fc62768341e1c2960cfaf4ad2496dd008291e`, tree
`d055bb5c362082a3b721d04ff1c44d8711d8d208`. The separate exact audited runtime source is
`d71671599c062244767494d392575cfacba5e1ff`, tree
`af7fa38ec50893550ce14026c39b428f8dbfd1f2`. The future reviewed harness result and
controller-injected final-run commit are unset and unavailable.

P3.B accepted exact orchestrator source
`06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7`, which is only the source base for P3.B2. Current
source/build status is not a runnable accepted built artifact. The P3.C input-freeze/run branch must
depend on an independently accepted exact P3.B2 built-entry result, never directly on P3.B or either
`cli-source` launcher.

OpenCode identities remain distinct: PR head
`fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f`; workflow merge
`2cbaa3f8d7f130ba41f07aab114a76f08cc311f1`; release source
`3186244c3103eb02d95a255b593847b14488b070`, tree
`8fba45aecd63ec61f334a856694cbd3da037df90`, base
`47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7`; run `32784750815`, attempt `1`, ref
`refs/pull/4/merge`, artifact `9541196940`; Actions ZIP
`601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c`; release manifest
`076dd096b36e34c47ad789c7b492d6b510f9b89cca9e6604f6fd0431c02d99fd`; Linux x64 tar
`fb1a48abaa25c412134c684f2c5b7ffa4fafd16d68c717fe0ede3ee655123308`; and binary
`4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e`.

## Provenance and safety invariants

Product requires exact source, pinned toolchain and a fresh isolated build. Orchestrator requires a
fresh isolated build from accepted P3.B2, not a claim about current P3.B source bytes. OpenCode uses
receipt/digest binding for sandbox behavior only; its receipt and release manifest are not signed build
provenance. The current candidate has no signed build attestation,
`unsignedProvenanceAccepted=false`, `productionEligible=false`, and `releaseEligible=false`. Signed
provenance remains required for production/release outside the all-false production activation gates.

P3.C0 runs no final E2E. Any future P3.C2 authority is sandbox/test-project-only and forbids real
project runtime or terminal use. Raw HTTP/SSE, built-owner WAL/journal, OpenCode effects and supervisor
records must bind to the controller nonce and verified process starts. Ambiguous external effects
become `operator_required` and are never automatically retried. No node enables production or launches
its successor.
