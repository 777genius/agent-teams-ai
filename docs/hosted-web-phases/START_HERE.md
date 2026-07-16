# Start here: Phase 2 JIT candidate

- Status: `candidate-awaiting-independent-root-review`
- Terminal state: `HOLD`

No Phase 2 product node is admissible from these unreviewed, unintegrated bytes.

## Mandatory read order

Every Phase 2 actor reads these items completely and in this order:

1. repository [AGENTS.md](../../AGENTS.md);
2. this file;
3. [EVIDENCE_LIFECYCLE.md](EVIDENCE_LIFECYCLE.md);
4. [hosted-web packet README](README.md);
5. [EXECUTION_INDEX.json](EXECUTION_INDEX.json);
6. [Phase 2 README](phase-02/README.md);
7. [Phase 2 controller packet](phase-02/controller-packet.md);
8. [Phase 2 execution DAG](phase-02/execution-dag.md);
9. repository [CLAUDE.md](../../CLAUDE.md);
10. [critical guardrails](../../AGENT_CRITICAL_GUARDRAILS.md);
11. [feature architecture standard](../FEATURE_ARCHITECTURE_STANDARD.md);
12. [packet standard](PACKET_STANDARD.md);
13. [orchestration responsibility boundary](ORCHESTRATION_GUARDS.md);
14. accepted predecessor handoff [phase-01-p1-f.json](../../.codex-handoff/phase-01-p1-f.json);
15. accepted predecessor review [phase-1-freeze.md](../research/hosted-web/phase-1/reviews/phase-1-freeze.md);
16. the assigned node packet; and
17. that packet's numbered source and test reads, in order.

Stop if a path, revision, dependency, ownership list or authority differs from the execution index.
Return a blocker handoff with `terminalState: HOLD`; do not repair authority informally.

## Current admission rule

The first eligible product node is `P2.F0.IDENTITY`, but only after an independent root reviewer
accepts this exact 12-path router and the broker integrates and activates those reviewed bytes. The
five lanes A-E additionally require accepted integration of the foundation node. Conditional DAG
authorization is not current launch authority.

## Safety

Use only deterministic unit tests and fresh marker-owned temporary roots. Never open or mutate a real
project, use product terminal behavior, launch teams or providers, or inspect credentials. Filesystem
tests reject unmarked, pre-existing, ambient, home and symlink-escaped roots before access and clean
up only their own marker-verified roots.

All producers self-review and hand off on `HOLD`. Separate review is limited to architecture,
security, integration and milestone roles. Documentation, research and evidence roles do not consume
or satisfy product capacity.
