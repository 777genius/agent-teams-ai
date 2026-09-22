# Start here: Hosted Core v1 P3.C0A source-lane admission

- Revision: `phase-03-p3-c0a-source-lane-admission-r6`
- Current node: `P3.C0A.SOURCE_LANE_ADMISSION`
- Source packet base: `cf3694f42f91795db4be0e564ed6eea11040768a`
- Source packet tree: `ca0ad7002439212788da12989c9abb150036b847`
- Result/phase-start commit: `UNSET` until independent review and CAS adoption
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
9. [P3.C0A source-lane registry and retained no-fake contract](phase-03/lanes/p3-c-no-fake-e2e.md);
10. repository [CLAUDE.md](../../CLAUDE.md);
11. [critical guardrails](../../AGENT_CRITICAL_GUARDRAILS.md);
12. [feature architecture standard](../FEATURE_ARCHITECTURE_STANDARD.md);
13. [packet standard](PACKET_STANDARD.md);
14. [orchestration responsibility boundary](ORCHESTRATION_GUARDS.md);
15. [Core v1 scope lock](../hosted-web-core-v1-scope-lock.md); and
16. the immutable worker-launch contract injected for the exact adopted phase SHA.

Stop on any revision, phase SHA, ownership, identity, sandbox or byte-binding mismatch. Return
`HOLD`; never repair authority from ambient state. The
[OpenCode downstream policy](../hosted-opencode-downstream-policy.md) remains a production/release
reference, not current execution authority.

## Authority boundary

The canonical Product repository is `777genius/agent-teams-ai`, and this packet is for Product PR
**#503**. The `pr252` text in historical job directory names is only a job naming prefix; it is never
the Product PR identity.

After exact independent review and atomic adoption, r6 admits isolated source implementation in the
registered source lanes and independent review of those exact patches. That is the only authority
class admitted. Source admission is not completion, build, freeze, run, production or release
eligibility. Candidate builds, `P3.C1` exact-input freeze, `P3.C2` execution, publication, deployment,
production activation and release remain forbidden. `authorizedRunsNow=0`,
`maximumAuthorizedRuns=0`, and every completion/build/freeze/run/production/release gate is false.

No document may contain or predict the r6 result commit as its own authority. After exact independent
review, `ProjectScopedControl` atomically injects the adopted `phaseStartSha` and diff binding through
a compare-and-swap adoption of `{revision, baseSha, phaseStartSha, diffSha256}`.

## Current source route

The active node/edge set is exactly the one rendered in the execution DAG. It admits six disjoint
source lanes, six independent review joins, the r431 schedule decision, and source adoption. Owner
release isolation follows Owner runtime review because both source epochs touch
`scripts/build.test.ts`. The route ends at `P3.SR.SOURCE_ADOPTION -> HOLD`; it has no executable edge
to a candidate build, exact-input freeze, run, release, deployment or production node.

The accepted provenance schema is exactly 54,393 bytes with SHA-256
`acde43e62b8ab42cc5fd2bbecc22f1b96d68f456bfa188b8c63730751222f498`. The r409 normative contract
decision supplies the four exact producer roles `opencode`, `owner`, `product-producer` and `browser`;
its unchanged Product handoff does not. The r431
decision supplies one OpenCode process and the seven-launch schedule and supersedes the earlier
eight-launch approval.

## Safety

This authority work runs no code, build, browser, provider, runtime, terminal or E2E. Any future
P3.C2 packet must still be limited to one fresh private marker-owned sandbox/test project and must
never open a real project in a runtime or terminal. Ambiguous provider effects remain durable
`operator_required` and are never automatically retried.

Pre-r6 draft patches are not retroactively accepted. After r6 adoption, each draft must be relaunched
or salvaged by exact immutable patch identity into a new r6-anchored workspace and independently
reviewed. End `HOLD`.
