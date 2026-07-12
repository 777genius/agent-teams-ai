# Proposed execution packet templates

Status: templates only. They must not be rendered until all Ready gates pass and serial bootstrap
replaces every proposal token with reviewed exact values. Producer target remains zero.

## Serial bootstrap record

```yaml
phaseId: phase-01
packetRevision: <resolved revision>
parentPlanCommit: <exact commit>
predecessorSha: <integrated Phase 0 freeze commit>
predecessorEvidenceIndexSha256: <integrated digest>
planBundleCommit: <reviewed bundle commit>
authorizationRef: <explicit implementation authorization>
phaseStartSha: <commit containing this record and resolved packets>
inheritedFailureLedger: <path and sha256>
resolvedIds: <proposal-to-final mapping path and sha256>
resolvedPathManifest: <one-writer manifest path and sha256>
fixtureManifest: <sandbox-only manifest path and sha256>
gapDispositionRegister: <P1-GAP-001..010 decisions and evidence owners>
phase1NoFilesystemAdapterGate: <positive/negative fixture, command, exact diagnostic>
deferredTestRootEscape: <Phase 2 owner, marked-root controls, reopening condition>
baseline: <commands, exit codes, versions, hashes>
```

Abort bootstrap if any value is absent, any proposed path overlaps, a dependency change appears, the
first slice requires production identity/auth or production IPC/HTTP mounting, a filesystem/path-taking
adapter appears, any `P1-GAP-001..010` disposition disappears, or current source contradicts the plan.

## Controller packet materialization checklist

- Status/authority: exact frozen values, active router state, ADR set, authorization.
- Outcome/non-goals: copy semantics from this bundle without broadening.
- Inputs/failures: integrated Phase 0 decisions and exact inherited fingerprints.
- Ready: every gate checked with evidence link.
- DAG/ownership: final IDs, exact files (no unresolved glob), one writer, estimate bucket, and exact
  `1B + 1C -> R1 -> 1D -> R2 -> I` dependency chain.
- Monitoring/capacity: unique slots, replacement/salvage, ten-minute useful-progress checks.
- Integration: adoption order, shared writer, commands, rollback, reject conditions.
- Done: evidence IDs, proof topology, risk budget, Phase 2 outputs.

## Worker lane packet template

```markdown
# Phase 1 <final lane ID>: <bounded result>

- Packet revision: <exact>
- Phase start SHA: <exact>
- Depends on: <final evidence IDs>
- Result states: verified | characterized | blocked | failed

## Mission

<One independently provable result.>

## Required reads

- AGENTS.md, CLAUDE.md, AGENT_CRITICAL_GUARDRAILS.md
- controller headings: <exact headings>
- parent-plan headings/ADRs: <exact headings>
- source/tests: <exact paths and symbols>

## Writable paths

- <exact exclusive files>
- .codex-handoff/phase-01-<lane>.json

Everything else, especially shared-writer files, package/lock/config files, and real projects, is
read-only.

## Deliverables and evidence

- <final evidence ID>: <artifact/schema/proof level>
- <positive and negative fixture IDs>
- <unique estimate bucket>

## Acceptance

<Observable semantics, negative controls, proof topology, performance/redaction rules, and claims that
must remain unverified.>

## Checks

- <exact deterministic focused commands>
- pnpm lint:fast:files -- <exact changed TypeScript files>
- git diff --check
- <scope, dependency, fixture, secret/path checks>

## Stop conditions

Stop on stale base/revision, overlap, source contradiction, dependency change, unsafe evidence,
production IPC/HTTP adapter exposure, filesystem-backed Phase 1 work, unclassified failure, or
falsified architecture. Return the standard
blocker record; do not widen scope.

## Handoff

Write the PACKET_STANDARD schema with exact commands/exit codes, evidence proof levels, changed paths,
unverified claims, blockers, estimate, and smallest next controller action.
```

## Reviewer packet template

A reviewer receives read-only producer paths and one exclusive review file. It must rerun deliberate
negative fixtures, compare source to packet, list every evidence ID as accept/reject/rework, verify
scope and redaction, and avoid repairing producer code. Reviewer handoff includes falsifiers attempted,
commands/exit codes, findings with owner/severity/reproducer, and integration recommendation.

## Integration packet template

The integration packet names one writer for the exact shared files, immutable adoption commits/order,
accepted review IDs, baseline fingerprints, complete command list, rollback procedure, and freeze
artifacts. It forbids opportunistic producer repair and later-phase work. Any changed contract,
ownership, proof topology, or dependency produces a reviewed packet revision rather than an informal
exception.
