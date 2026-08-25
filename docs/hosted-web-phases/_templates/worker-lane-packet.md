# Phase <N> <Lane>: <Bounded concern>

- Packet revision: `<phase-N-rM>`
- Evidence owner: `<lane>`
- Depends on: `<contract/evidence IDs>`
- Result states: `verified | characterized | blocked | failed`

## Mission

One bounded result that this worker can prove independently.

## Required reads

- phase controller packet sections: `<headings>`;
- master-plan headings/ADR IDs: `<headings/ids>`;
- source entrypoints and characterization tests: `<paths/symbols>`.

Do not instruct the worker to read the entire master plan unless the lane is an architecture-wide audit.

## Writable paths

- `<exclusive path glob>`
- worktree-local `.codex-handoff/<phase>-<lane>.json`

List shared and production paths that remain read-only. An overlap is `packet_conflict`, not permission
to coordinate informal concurrent edits.

## Evidence

- `<stable evidence ID>`: `<artifact and schema>`
- `<stable evidence ID>`: `<positive/negative fixture>`
- `<stable evidence ID>`: `<estimate bucket>`

## Acceptance

State observable success, required negative controls, proof topology, compatibility conditions and the
claim that must remain `unverified` when the environment is unavailable.

## Forbidden scope

Name later-phase behavior, broad cleanup, dependency changes, real-project testing and authority changes.

## Checks

- deterministic focused test command;
- `pnpm lint:fast:files -- <changed TypeScript files>` when applicable;
- `git diff --check`;
- lane-specific schema/generator/negative-control checks.

## Stop conditions

Stop on stale revision/base, source-plan mismatch, unsafe secret/user-project access, ownership overlap,
unclassified inherited failure or falsified required architecture. Return the standard blocker record.

## Handoff

Write the schema from `PACKET_STANDARD.md`. Include exact commands and exit codes, evidence proof levels,
unverified claims, ADR recommendation, estimate buckets and the smallest safe next controller action.
