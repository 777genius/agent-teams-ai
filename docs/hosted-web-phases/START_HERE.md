# Start here: Hosted Core v1 actual-owner closure

- Revision: `phase-03-actual-owner-closure-r1`
- Current node: `P3.A.PRODUCT_BINDING`
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
9. [P3.A product binding lane](phase-03/lanes/p3-a-product-binding.md);
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

`P3.A` inspects the current production composition before editing. It may return a verified zero-code
result. If a real gap exists, it implements only the smallest signed-v4 binding seam within its exact
ownership. A fresh reviewer must accept the exact result with P0/P1/P2 `0/0/0` before integration.

After the orchestrator change is independently accepted and integrated, the controller may
materialize the E2E packet. The E2E uses only a newly created marker-owned sandbox project and exact
pinned artifacts. It proves request, durable pending state, authenticated browser decision, owner
delivery, reconciliation, restart, stale authority, replacement, ambiguity, isolation, and cleanup.
Only its accepted exact-head evidence can unlock coordinated activation.

## Safety

Never use a real user project, shared user runtime state, real provider agent, product terminal, or
ambient home data. `P3.A` performs no launch or smoke flow at all. A later E2E node may launch only
inside its declared fresh sandbox. Do not enable any production eligibility flag, repin OpenCode from
unverified bytes, add dependencies, or expand deferred Hosted parity. Runtime primitives do not
choose the DAG.
