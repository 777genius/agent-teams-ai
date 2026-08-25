# Hosted Web Phase 0 evidence

This directory contains the serialized Phase 0A baseline record for packet `phase-00-r2`. It does not
claim that Phase 0, the six evidence lanes, or the Phase 0 freeze is complete. No hosted product or
terminal behavior is enabled by these files.

## Pinned lineage

| Fact | Value |
| --- | --- |
| Canonical repository | `https://github.com/777genius/agent-teams-ai.git` |
| Base branch | `refactor/team-provisioning-round2-reapply` |
| Pinned base | `cbe501ad0f1fa0e51a038e832ad35fce4120321b` |
| Source plan bundle | `16c156db8a85e75a6b679f6919e1013af74fb112` |
| Adopted plan bundle | `f1ad7a8cba2f26abf5f42ddd206937c24d143f77` |
| Baseline integration head | `c1b8e3fe69e1c05ad94ec0c0301def25c8a464b5` |
| Packet revision | `phase-00-r2` |

The source plan commit is review provenance, not an ancestor of the implementation branch. The
content-equivalent reviewed bundle was adopted as `f1ad7a8cba2f26abf5f42ddd206937c24d143f77`, which
descends from the pinned base. The baseline integration head descends from both the base and the
adopted bundle.

## Artifacts

- [`base.json`](./base.json) is the machine-readable pin, plan hash, toolchain, controller, cache and
  external-evidence record.
- [`baseline.md`](./baseline.md) records the reproducible gate and the complete inherited-failure
  classification.
- [`lane-ledger.json`](./lane-ledger.json) reserves one unique slot for each Phase 0 lane. All remain
  unstarted until the evidence commit SHA is recorded externally as `phaseStartSha`.
- [`estimate-ledger.md`](./estimate-ledger.md) records the non-duplicated pre-inventory v1 estimate.
- [`salvage-ledger.md`](./salvage-ledger.md) records that no closed-PR production asset was salvaged in
  0A.
- [`decision-register.md`](./decision-register.md) records only decisions closed or narrowed by 0A.

## Current gate state

`pnpm check:ci` ran against `c1b8e3fe69e1c05ad94ec0c0301def25c8a464b5` and exited `1` after
2,211 seconds. Type checking, workspace tests, workspace builds and MCP E2E passed. The sole failing
stage was full root lint: five errors already present at the pinned base, grouped into two
`base_owned_fix` records. There are no `unknown`, `base_blocker`, or environment failures in the
captured run.

The packet's separate `lint:fast` and `standalone:build` invocations were not rerun for this evidence
write. The supplied broad run proves its nested typecheck, test, workspace build and MCP E2E stages,
but a workspace build is not relabeled as `standalone:build`. See `baseline.md` for the exact coverage
and limitation.

## `phaseStartSha` resolution

A Git commit cannot contain its own SHA. Therefore `base.json` and every unstarted lane slot contain
`phaseStartSha: null`. The integration controller must adopt exactly these seven reviewed files,
record the resulting immutable evidence commit in its external integration-attempt record, and inject
that SHA into every lane job, prompt and runtime lane-ledger overlay. That external commit is the only
valid lane `phaseStartSha`; `c1b8e3fe69e1c05ad94ec0c0301def25c8a464b5` is only the pre-evidence
integration head.

## Operational incident

The first baseline evidence job had `prewarmOnStart=true` and entered a runaway prewarm failure loop:
22 attempts in under five minutes, ending with `subscription_worker_prewarm_failed` and
`codex_app_server_exited:1` without changing files. The replacement v2 baseline job and clean v2 jobs
use `prewarmOnStart=false`. This is an orchestration incident, not a repository gate failure.
