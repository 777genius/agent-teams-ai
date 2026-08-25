# Phase 03: approval actual-owner closure

- Status: `active / no-fake E2E only`
- Packet revision: `phase-03-actual-owner-closure-r3`
- Current node: `P3.C.NO_FAKE_E2E`
- Terminal state: `HOLD`

## Outcome

Close the remaining Hosted Core v1 approval actual-owner boundary with one thin vertical slice. The
product consumes only launcher-signed v4 per-team route authority, the orchestrator starts its actual
control owner before active admission, and one sandbox-only no-fake E2E proves the complete approval
decision path. Production eligibility stays false until all three exact revisions pass together.

## Current scope

Only [P3.C no-fake actual-owner E2E](lanes/p3-c-no-fake-e2e.md) is launchable after a controller
injects the exact immutable launch contract. Its accepted predecessors are:

- product PR #252 at `d71671599c062244767494d392575cfacba5e1ff`: P3.A plus independent P3.RA
  P0/P1/P2 `0/0/0`, with green in-scope CI;
- orchestrator PR #44 at `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7`: independent O3 P0/P1/P2
  `0/0/0`, 41/41 focused tests, build, and exact-head CI green; and
- OpenCode candidate PR #4 at `fe07feb2f6c1a1d58ffb65d2f269c8fb3de4ca8f`, Actions workflow run
  `32784750815`, artifact `9541196940`, ZIP SHA-256
  `601e3bf7713ff4180d449cc788e6000a2b706fb01f7cd11647379ab45c004b0c`,
  Linux x64 executable SHA-256
  `4947f69d85d491b5f73ef1c9306a5ef69c2991800fbd40f05f2b15a53f57299e`, with
  `productionEligible=false`.

The lane selectively ports only the preservation branch behavior required to exercise activation-v2
against the actual owner and actual OpenCode process. `P3.F` remains unmaterialized and unauthorized.
P3.C completion acceptance also remains false pending a fresh exact-result P0/P1/P2 `0/0/0` review.
The PR #4 artifact is a sandbox-only candidate: it does not supersede the unchanged current
production lock and cannot activate production. Product and orchestrator execution must use closures
created by the runner from fresh clean isolated worktrees at their exact accepted commits. The runner
accepts only the two versioned commit-scoped recipe IDs defined by future `run.ts`; caller build argv
and output selection are forbidden. Pinned executable/toolchain/lockfile identities, sanitized
environment, no-shell direct steps, absent output/closure roots, complete recursive closure manifests,
deterministic Merkle roots, same-descriptor hash/copy, and post-build plus pre-stage HEAD/source/index
revalidation are mandatory. The product closure includes both real standalone outputs and the complete
Docker production dependency/package tree; the orchestrator closure includes tracked `cli` and all of
`dist/local-cli`. OpenCode requires the private canonical ZIP plus immutable signed attestation and
manifest, independent checks of all five fixed identifiers, and secure private extraction without a
network download.
The future lane-owned `run.ts` is not present in this documentation-only packet.

## Non-goals

- no new general lifecycle coordinator or runtime platform;
- no legacy v2/v3 approval route activation;
- no broad Hosted parity, terminal, review, attachments, member recovery, or destructive recovery;
- no OpenCode product customization beyond the bounded atomic approval compatibility patch;
- no real project, real provider identity/data, shared user state, or production rollout; and
- no production gate or artifact eligibility change in this packet.

See [controller-packet.md](controller-packet.md) for acceptance and
[execution-dag.md](execution-dag.md) for the only legal ordering.
