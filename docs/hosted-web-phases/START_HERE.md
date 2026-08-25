# Start here: Hosted Core v1 actual-owner closure

- Revision: `phase-03-actual-owner-closure-r3`
- Current node: `P3.C.NO_FAKE_E2E`
- Current authority: exact phase SHA supplied by `ProjectScopedControl`
- Terminal state: `HOLD`

The live-head synchronization route is complete and historical. Phase 03 is the bounded closure for
the signed-v4 approval actual-owner path. It does not authorize broad parity, a second lifecycle
platform, real-project runtime testing, or production activation.

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
9. [P3.C no-fake actual-owner E2E lane](phase-03/lanes/p3-c-no-fake-e2e.md);
10. repository [CLAUDE.md](../../CLAUDE.md);
11. [critical guardrails](../../AGENT_CRITICAL_GUARDRAILS.md);
12. [feature architecture standard](../FEATURE_ARCHITECTURE_STANDARD.md);
13. [packet standard](PACKET_STANDARD.md);
14. [orchestration responsibility boundary](ORCHESTRATION_GUARDS.md);
15. [Core v1 scope lock](../hosted-web-core-v1-scope-lock.md), especially approval actual-owner
    admission and production activation;
16. [OpenCode downstream policy](../hosted-opencode-downstream-policy.md); and
17. the immutable worker-launch contract injected for this exact phase SHA.

Stop on any revision, repository, phase SHA, packet, scope, dependency, signed-v4 authority, or
sandbox mismatch. Return `HOLD`; do not repair authority informally.

## Route

The accepted product head `d71671599c062244767494d392575cfacba5e1ff` closed `P3.A` and passed
fresh `P3.RA` architecture/security review with P0/P1/P2 `0/0/0` and green in-scope CI. The accepted
orchestrator head `06e5dd89aee920c6e3ecd8ff0efbfcf5135021b7` closed `P3.B` with an
independent O3 P0/P1/P2 `0/0/0` review, 41/41 focused tests, build, and exact-head CI green.

Only `P3.C` is active. It is a thin activation-v2 port of preservation branch
`test/hosted-actual-owner-harness-r4`, not a merge or wholesale copy of that branch's roughly
8.7k-line harness. It uses one newly created marker-owned sandbox/test project and the exact accepted
product, orchestrator, and OpenCode candidate closures. It must prove the complete no-fake path and its
bounded negative/recovery matrix before a fresh review can even consider `P3.F`.
The P3.C completion-acceptance gate remains false until that independent review accepts the exact
result with P0/P1/P2 `0/0/0`.

The current `opencode-hosted-runtime.lock.json` remains production authority. The P3.C OpenCode PR #4
artifact is sandbox-only, `productionEligible=false`, does not supersede that lock, and cannot
activate production. Executing product and orchestrator bytes must be bound to their accepted commits
only by runner-executed fresh builds in separate clean exact-commit worktrees. The caller passes only
the two versioned commit-scoped recipe IDs owned by future `run.ts`, never build argv or outputs. The
recipes pin executable/toolchain/lockfile digests, sanitize an allowlisted environment, use ordered
direct argv without a shell, and allow substitution only of controller-private canonical roots. All
output/closure roots start absent. Descriptor-relative `O_NOFOLLOW` walks hash and copy every
single-link regular closure file through the same stable descriptor into complete sorted manifests
and deterministic Merkle roots; missing, extra, undeclared, linked, escaped or changed content fails.
Accepted HEAD and tracked source/index are revalidated after build and immediately before staging.

OpenCode is admitted only from controller-supplied private canonical ZIP, immutable signed
attestation, and immutable manifest paths. The runner independently checks commit, run, artifact, ZIP
and executable pins, authenticates all attested fields/digests, securely extracts into a private empty
root, and stages the verified executable without a network re-download.

## Safety

Never use a real user project, shared user runtime state, real provider identity/data, product
terminal, or ambient home data. `P3.C` may later launch only the exact lane-owned harness inside its
single declared fresh sandbox; this r3 packet-materialization change launches nothing. Do not enable
any production eligibility flag, mutate an artifact lock, add dependencies, or expand deferred
Hosted parity. The future lane-owned `run.ts` is declared but does not exist in this docs-only packet.
Runtime primitives do not choose the DAG. End `HOLD`.
