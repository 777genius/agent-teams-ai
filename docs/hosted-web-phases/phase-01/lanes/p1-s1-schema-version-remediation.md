# P1.S1 schema-version remediation lane

## Authority and provenance

- Project: `agent-teams-hosted-web-refactor`
- Phase/lane: `phase-01` / `p1-s1-schema-version-remediation`
- Evidence owner: `P1.1A-schema-version-remediation`
- Packet revision: `phase-01-s1-schema-version-remediation-r1`
- Controller: `docs/hosted-web-phases/phase-01/controller-packet.md`
- Remediation base: integrated P1.S1 commit `da9625e78c0c96699162793a7ebba0657140d937`
- Result states: `verified | characterized | blocked | failed`
- Capacity: exactly one future serial producer; no retry, refill, parallel duplicate, or successor
  provisioning

This packet records the authoritative operator-provided disposition of the independent integration
review, quoted verbatim:

> "Independent integration review formally REJECTED P1.S1 commit da9625e78 only for incomplete
> P1.NEG.SCHEMA_VERSION."

The review applies to the integrated commit above and only to `P1.NEG.SCHEMA_VERSION`. All other
useful integrated P1.S1 kernel work is preserved. This packet explicitly supersedes
`phase-01-s1-foundations-r1` as worker-start authority; it does not supersede, rewrite, or erase the
integrated commit, its handoff, accepted P1.S0 evidence, or any evidence-catalog row. The independent
review finding supplied by the operator is the provenance for this bounded replacement authority.

## Mission

Remediate only revision/schema-version parsing and the focused tests and fixtures needed to close the
quoted `P1.NEG.SCHEMA_VERSION` finding. The implementation must use the stable diagnostic
`phase1-schema-version-invalid-or-unsupported` for every schema-version or input-object rejection
described below.

The future worker must preserve the rest of `da9625e78` byte-for-byte. Passing this lane returns a
candidate for independent review and controller integration. It does not authorize `P1.S2`, product
transport work, another remediation attempt, or a router advance.

## Exact worker-start identity

The hosting subscription runtime may admit work only when one `worker-start-v1` contract binds all of
the following values together:

```text
projectId: agent-teams-hosted-web-refactor
controllerJobId: phase-01-p1-s1-schema-version-remediation-controller-r1
phaseId: phase-01
laneId: p1-s1-schema-version-remediation
packetRevision: phase-01-s1-schema-version-remediation-r1
parentPlanCommit: 3bc0dfa7c00261785c0c752270cb302a9294e751
baseSha: da9625e78c0c96699162793a7ebba0657140d937
controllerPacket: docs/hosted-web-phases/phase-01/controller-packet.md
lanePacket: docs/hosted-web-phases/phase-01/lanes/p1-s1-schema-version-remediation.md
handoffPath: .codex-handoff/phase-01-p1-s1-schema-version-remediation.json
```

`planBundleCommit` and `phaseStartSha` must both resolve to the exact integrated docs-only router
packet commit selected by the controller. That commit must descend directly or transitively from
`baseSha`, contain this packet revision, and leave every non-router path identical to `baseSha`.
`sourceWorktree` must be a new isolated worktree created from that `phaseStartSha`. No worker may be
started from `da9625e78` before this packet is integrated.

Every cross-product with the superseded foundations packet, a different lane, a different base, a
second job, or any `P1.S2` packet fails closed with `packet_conflict` or `packet_stale`.

## Exact required reads

The runtime contract must list every path below exactly. Directory roots, globs, recursive reads, and
implicit sibling authority are invalid.

### Mandatory baseline, in reading order

- `AGENTS.md`
- `docs/hosted-web-phases/START_HERE.md`
- `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
- `docs/hosted-web-phases/README.md`
- `docs/hosted-web-phases/EXECUTION_INDEX.json`
- `docs/hosted-web-phases/phase-01/controller-packet.md`
- `docs/hosted-web-phases/phase-01/lanes/p1-s1-schema-version-remediation.md`

### Mandatory implementation inputs

- `CLAUDE.md`
- `AGENT_CRITICAL_GUARDRAILS.md`
- `docs/hosted-web-phases/PACKET_STANDARD.md`
- `src/shared/contracts/hosted/revision.ts`
- `src/shared/contracts/hosted/index.ts`
- `test/architecture/hosted-web/phase-1/contracts/revision.test.ts`
- `test/architecture/hosted-web/phase-1/contracts/fixtures/invalid-contract-values.json`
- `test/architecture/hosted-web/phase-1/contracts/fixtures/valid-contract-values.json`
- `.codex-handoff/phase-01-p1-1a.json`
- `package.json`
- `tsconfig.json`
- `vitest.config.ts`

There are no mandatory scripts and no authority to read or change preserved Phase 0 or accepted P1.S0
evidence.

## Exact writable paths

- `.codex-handoff/phase-01-p1-s1-schema-version-remediation.json`
- `src/shared/contracts/hosted/revision.ts`
- `test/architecture/hosted-web/phase-1/contracts/revision.test.ts`
- `test/architecture/hosted-web/phase-1/contracts/fixtures/invalid-contract-values.json`
- `test/architecture/hosted-web/phase-1/contracts/fixtures/valid-contract-values.json`

Everything else is read-only, including `src/shared/contracts/hosted/index.ts`, every other product or
test file, configuration, package and lock files, accepted P1.S0 evidence, the integrated P1.S1
handoff, research, documentation, and orchestration. A need to change another path is a stop condition,
not permission to widen the lane.

## Definition of Ready

- [ ] The router packet commit is integrated after `da9625e78`, and the runtime binds that exact commit
      as both `planBundleCommit` and `phaseStartSha`.
- [ ] The five owned implementation/test/fixture paths match `da9625e78` before work starts, and all
      useful non-owned P1.S1 kernel work remains present and unchanged.
- [ ] The accepted P1.S0 evidence paths and historical P1.S0 `phaseStartSha` remain unchanged.
- [ ] The runtime contract contains the exact identity, reads, writable paths, checks, and handoff path
      from this packet.
- [ ] No producer is running or has already consumed this packet revision; active `P1.S2` producer
      count is zero.
- [ ] The controller records the quoted independent-review finding and confirms that no product
      remediation occurred before packet integration.

Failure of any Ready item stops admission. It does not authorize repair, launch, or retry from this
docs-only packet producer.

## Acceptance

1. Malformed, missing, non-object, future, and incompatible schema-version inputs fail with exactly
   `phase1-schema-version-invalid-or-unsupported`.
2. A same-version response object is accepted only after every declared known field has been
   validated. The returned value is a fresh known-field projection, so every additive response field
   is discarded rather than retained, spread, or returned by reference.
3. A response with a valid version but an invalid or missing known field fails before additive fields
   can be ignored, using the same schema-version diagnostic.
4. An input object is accepted only when its declared known fields validate and it contains no
   disallowed unknown own fields. Any disallowed unknown input-object field fails with the same
   schema-version diagnostic.
5. Focused fixtures and tests demonstrate additive response-field discard, known-field-first response
   validation, disallowed input-field rejection, and the existing malformed/missing/future/
   incompatible version matrix. A test that merely asserts the source object still contains an
   additive field is insufficient.
6. Revision/cursor equality-only behavior, all other exported kernel behavior, and every non-owned
   byte from `da9625e78` remain unchanged. No dependency, public barrel, feature DTO, generic schema
   framework, transport contract, route, capability, or production registration is added.
7. The handoff identifies `P1.1A.VERSION.REMEDIATION` and `P1.NEG.SCHEMA_VERSION`, records the exact
   diagnostic and negative results, and makes no Phase 1, P1.S2, or production-hosted completion claim.

## Required checks

Run from the bound `sourceWorktree` and record the exact commands, exit codes, and relevant tool
versions in the handoff:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/contracts/revision.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/contracts
pnpm lint:fast:files -- src/shared/contracts/hosted/revision.ts test/architecture/hosted-web/phase-1/contracts/revision.test.ts
pnpm typecheck
pnpm exec prettier --check .codex-handoff/phase-01-p1-s1-schema-version-remediation.json src/shared/contracts/hosted/revision.ts test/architecture/hosted-web/phase-1/contracts/revision.test.ts test/architecture/hosted-web/phase-1/contracts/fixtures/invalid-contract-values.json test/architecture/hosted-web/phase-1/contracts/fixtures/valid-contract-values.json
git diff --check
git status --short
```

Also compare the changed-path set with the five exact writable implementation/test/fixture paths plus
the handoff path; prove every non-owned path matches `phaseStartSha`; prove `phaseStartSha` differs
from `da9625e78` only on the bounded router/controller/lane documentation paths; and scan every changed
or untracked file for secrets, credentials, auth/provider payloads, private/home paths, raw command or
runtime bodies, and real-project names. A zero-match tracked-only scan is insufficient. An inherited
check failure may be characterized only with an unchanged baseline fingerprint and no owned-path
diagnostic.

## Stop conditions

Stop and return the `PACKET_STANDARD.md` blocker record on a stale base, packet, plan bundle, or phase
start; a missing or altered review quote; pre-integration product remediation; concurrent or prior use
of this one-shot packet revision; path overlap; any changed accepted S0 evidence or non-owned P1.S1
byte; a need for another source, test, fixture, config, dependency, docs, research, or orchestration
path; failure to produce the exact diagnostic; inability to validate known response fields before
discarding additive fields; inability to reject disallowed input fields; an owned-path baseline
failure; secret/private-path evidence; or any attempt to start `P1.S2`.

A blocked, failed, or rejected result ends this node. Do not retry, refill, salvage into a broader
worktree, or launch a replacement. The controller must issue a separately reviewed packet revision
before any further producer can exist.

## Handoff

Write `.codex-handoff/phase-01-p1-s1-schema-version-remediation.json` with the schema from
`PACKET_STANDARD.md`. Include the immutable `baseSha`, exact `phaseStartSha`, plan-bundle commit,
packet revision, independent-review quote and provenance, explicit superseded packet revision, result
commit when available, both evidence IDs and proof levels, every changed path, exact commands and exit
codes, tool versions, the complete negative-result matrix, unverified claims, blockers, and the patch
manifest (`git diff --binary --full-index <phaseStartSha>` SHA-256 plus changed-path SHA-256 values).

The smallest safe successor-controller objective is: independently review the remediation candidate
against the quoted finding; if and only if accepted, integrate it on top of the router packet commit,
record the exact integration commit and reciprocal provenance, and keep `P1.S2` blocked. Any `P1.S2`
authorization requires a separate later router packet and is not a successor action of this node.
