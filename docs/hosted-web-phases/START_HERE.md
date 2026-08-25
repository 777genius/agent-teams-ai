# Start here: Hosted Core v1 P3.C0 input repacket

- Revision: `phase-03-p3-c0-input-repacket-r5`
- Current node: `P3.C0.INPUT_REPACKET`
- Packet/base commit: `720fc62768341e1c2960cfaf4ad2496dd008291e`
- Current authority: exact phase SHA supplied by `ProjectScopedControl`
- Terminal state: `HOLD`

## Mandatory read order

Every actor reads these items completely and in this order:

1. repository [AGENTS.md](../../AGENTS.md);
2. this file;
3. [EVIDENCE_LIFECYCLE.md](EVIDENCE_LIFECYCLE.md);
4. [hosted-web packet README](README.md);
5. [EXECUTION_INDEX.json](EXECUTION_INDEX.json);
6. [Phase 03 navigation record](phase-03/README.md);
7. [Phase 03 controller packet](phase-03/controller-packet.md);
8. [Phase 03 execution DAG](phase-03/execution-dag.md);
9. [P3.C0 repacket and future no-fake lane](phase-03/lanes/p3-c-no-fake-e2e.md);
10. repository [CLAUDE.md](../../CLAUDE.md);
11. [critical guardrails](../../AGENT_CRITICAL_GUARDRAILS.md);
12. [feature architecture standard](../FEATURE_ARCHITECTURE_STANDARD.md);
13. [packet standard](PACKET_STANDARD.md);
14. [orchestration responsibility boundary](ORCHESTRATION_GUARDS.md);
15. [Core v1 scope lock](../hosted-web-core-v1-scope-lock.md); and
16. the immutable worker-launch contract injected for the exact phase SHA.

Stop on any revision, phase SHA, ownership, identity, sandbox or byte-binding mismatch. Return
`HOLD`; never repair authority from ambient state. The
[OpenCode downstream policy](../hosted-opencode-downstream-policy.md) remains a production/release
reference, not current sandbox execution authority.

## Current authority and identities

P3.C0 is a seven-file, zero-code repacket. It authorizes no implementation, process, browser,
provider, runtime, terminal or final E2E execution. Its product identities are independent:

- packet and future harness base commit
  `720fc62768341e1c2960cfaf4ad2496dd008291e` (tree
  `d055bb5c362082a3b721d04ff1c44d8711d8d208`);
- audited runtime-source commit `d71671599c062244767494d392575cfacba5e1ff` (tree
  `af7fa38ec50893550ce14026c39b428f8dbfd1f2`), resolved from repository history and retained as the
  exact P3.A/P3.RA runtime descriptor; and
- future reviewed harness result/final-run commit, currently unset, unreviewed and unavailable. Only
  the controller may inject it after independent acceptance.

P3.B accepted exact orchestrator PR #44 source
`06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7`; that is a source base, not a runnable accepted built
artifact. P3.C execution must consume a future independently accepted
`P3.B2.BUILT_ACTUAL_OWNER_ENTRY` result and exact build recipe. It must never depend directly on P3.B
or invoke either source-mode `cli-source` launcher for the final run.

The OpenCode sandbox candidate binds separate, non-interchangeable identities:

- PR head `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f`;
- workflow merge `2cbaa3f8d7f130ba41f07aab114a76f08cc311f1`;
- release source `3186244c3103eb02d95a255b593847b14488b070`, source tree
  `8fba45aecd63ec61f334a856694cbd3da037df90`, and release base
  `47b6b6f5f4f9b42d2bce7af1c4e5bf6efaf22ba7`;
- workflow run `32784750815`, attempt `1`, ref `refs/pull/4/merge`, artifact `9541196940`;
- Actions ZIP SHA-256 `601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c`;
- release-manifest SHA-256 `076dd096b36e34c47ad789c7b492d6b510f9b89cca9e6604f6fd0431c02d99fd`;
- Linux x64 tar SHA-256 `fb1a48abaa25c412134c684f2c5b7ffa4fafd16d68c717fe0ede3ee655123308`;
  and
- Linux x64 binary SHA-256 `4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e`.

The acquisition receipt and digests are a sandbox byte-binding policy, not signed build provenance.
The current candidate has no signed build attestation; `unsignedProvenanceAccepted=false`,
`productionEligible=false`, and `releaseEligible=false`. Signed provenance remains required before
production or release, outside the all-false production activation gates.

## Exact route

After this repacket is independently adopted, and only through new controller packets, run these
three nodes in parallel:

```text
P3.C0.INPUT_REPACKET
  +-> OC.PROVENANCE.V1 --------------------+
  +-> P3.B2.BUILT_ACTUAL_OWNER_ENTRY ------+-> P3.C1.EXACT_INPUT_FREEZE
  +-> P3.C.HARNESS_IMPLEMENTATION ---------+             |
                                                          v
                                              P3.C2.FINAL_NO_FAKE_RUN
                                                  exactly one sandbox run
                                                          |
                                                          v
                                              P3.RC.INDEPENDENT_ACCEPTANCE
                                                          |
                                                        HOLD
```

`P3.F.COORDINATED_ACTIVATION` is controller-only and unmaterialized. It has no worker-created edge
from this packet.

## Safety and evidence

Any future P3.C2 authority is limited to one fresh private marker-owned sandbox/test project and one
disjoint evidence root. A real project must never be opened in the runtime or terminal. Behavioral
truth must come from raw HTTP/SSE, built-owner WAL/journal, OpenCode effects and supervisor records
bound to the controller nonce and verified process starts. Reports, fixtures and summaries are only
indexes.

Ambiguous provider effects become durable `operator_required`; ordinary delivery never
automatically retries them. Only explicit reconciliation proving `not_delivered` may authorize one
new fenced attempt.

This materialization edits only the seven authority documents named in the index. It performs no
final E2E, no product/orchestrator/OpenCode execution, no source/runtime/test implementation, no
production enablement and no successor launch. End `HOLD`.
