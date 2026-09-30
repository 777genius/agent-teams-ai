# Hosted Web Execution Packet Standard

## Why packets exist

A packet is a bounded execution contract, not a summary of the master plan. It must let one controller
or worker act autonomously without inventing scope, ownership, acceptance criteria or recovery rules.

## Phase controller packet

Each phase controller packet contains:

1. `Status and authority`: phase, revision, predecessor evidence, active/blocked state.
2. `Outcome`: one measurable phase result.
3. `Inputs`: immutable base SHA, plan revision, ADR set and inherited failure ledger.
4. `Non-goals`: later-phase and explicitly deferred behavior.
5. `Definition of Ready`: authorization, host admission and evidence prerequisites.
6. `DAG`: serial bootstrap, parallel lanes, reviews, adoption and freeze.
7. `Ownership`: exact exclusive writable paths and shared integration-only paths.
8. `Lane registry`: packet path, dependencies, evidence IDs and estimate bucket per lane.
9. `Capacity epochs`: unique lane slots, replacement/supersession and legal review transitions.
10. `Monitoring`: freshness, useful progress, overlap, debt and intervention thresholds.
11. `Integration`: review pairs, adoption order, required checks and rejection conditions.
12. `Definition of Done`: artifacts, proof level, open-risk budget and next-phase inputs.

The controller packet owns orchestration semantics. It never gives a controller raw shell, raw tmux,
raw Git writer or direct registry rights.

## Lane packet

Each lane packet contains:

- stable lane and evidence IDs;
- packet revision and parent phase;
- one mission and explicit non-goals;
- exact required reads, with master-plan headings rather than the entire document;
- exclusive writable paths and prohibited shared paths;
- deliverables with machine-readable schemas where applicable;
- acceptance and negative-control requirements;
- targeted checks;
- stop conditions;
- a structured handoff contract.

One worker receives one lane packet. Cross-lane work is requested through the controller and results in
a new reviewed packet revision or a separate lane; it is never accepted through an informal prompt.

## Immutable runtime facts

The controller injects these values when rendering a worker prompt:

```text
projectId
controllerJobId
phaseId
laneId
packetRevision
parentPlanCommit
baseSha
planBundleCommit
phaseStartSha
sourceWorktree
writablePaths
requiredCheckCommands
handoffPath
```

Packet files do not hardcode a moving branch head as immutable truth. A displayed SHA is an observed
snapshot; the controller's 0A/base record is authoritative once a phase starts. A child lane starts only
from `phaseStartSha`, which contains the reviewed packet bundle and serial bootstrap evidence.

## Evidence identity

Every deliverable has a stable evidence ID such as `P0.W3.STATE_FAMILY_CATALOG`. The ID survives file
renames and retries and appears in:

- the lane packet;
- the produced evidence index;
- review findings;
- the integration attempt;
- the phase decision register and estimate reconciliation.

An evidence ID has one integration owner. Two workers may independently review or falsify evidence,
but they may not both publish competing canonical rows without a controller resolution.

## Proof levels

| Level                   | Meaning                                                         | May close acceptance?           |
| ----------------------- | --------------------------------------------------------------- | ------------------------------- |
| `source_observed`       | Relevant production source was traced                           | no                              |
| `fixture_characterized` | Deterministic positive and negative fixtures reproduce behavior | only characterization gates     |
| `target_verified`       | Required test ran in the declared final-shape topology          | yes                             |
| `live_sandbox_verified` | Provider/runtime smoke ran only in a new test project           | only when the phase requires it |
| `unverified`            | Claim is inferred or required environment was unavailable       | no                              |

Tests on real user projects are forbidden regardless of proof level.

## Required handoff

Workers write a worktree-local `.codex-handoff/<phase>-<lane>.json` with this shape:

```json
{
  "schemaVersion": 1,
  "phaseId": "phase-00",
  "laneId": "w1",
  "packetRevision": "phase-00-r2",
  "baseSha": "<immutable phase SHA>",
  "status": "verified | characterized | blocked | failed",
  "evidence": [
    {
      "id": "P0.W1.API_PARITY_LEDGER",
      "path": "docs/research/hosted-web/phase-0/parity-renderer/api-parity-ledger.json",
      "proofLevel": "fixture_characterized"
    }
  ],
  "changedPaths": [],
  "checks": [{ "command": "<exact command>", "exitCode": 0 }],
  "unverifiedClaims": [],
  "blockers": [],
  "adrRecommendations": [],
  "estimateBuckets": [],
  "nextAction": "review"
}
```

The handoff never contains secrets, auth payloads, raw provider payloads or sensitive command bodies.
The controller rejects a handoff with an unknown evidence ID, stale packet revision, different base SHA,
out-of-scope changed path or a `verified` claim whose required check is absent.

## Blocker protocol

When blocked, a worker stops changing code and returns:

- blocker class: `packet_conflict`, `packet_stale`, `base_failure`, `environment`, `scope_overlap`,
  `security`, `missing_evidence` or `design_falsified`;
- smallest reproducer or source reference;
- affected evidence IDs;
- whether unrelated lane work can continue;
- one recommended controller action.

The worker does not silently reinterpret the packet or widen its writable paths.

## Packet revision rules

A packet revision changes when ownership, deliverables, acceptance, required ADRs, integration order or
proof topology changes. Typographical edits may keep the revision.

An active packet revision is immutable for an existing worker. The controller either lets the worker
finish under that revision or stops it and issues a new worktree/job with an explicit salvage decision.

## Just-in-time rule

Future phase packets are materialized only after predecessor freeze. Before that, the master plan's
phase sections describe intent and dependencies but are not executable worker instructions.

This avoids two failure modes:

- false precision: later packets encode assumptions Phase 0 is meant to test;
- distributed drift: the same ADR or contract is copied into many files and later diverges.
