# Phase 0 cross-lane remediation audit v2

Disposition: **W3 bundle pair-accepted; hold every other lane bundle; no integration performed**.

The original W1-W6 producers are complete, but all three original reciprocal reviews rejected both
lanes. The remediation worktrees preserve useful progress, yet only W3 has a terminal producer result
and complete remediation handoff. W1, W2, W4, W5 and W6 retain dirty output under stale `running`
registry records with no result. Their files were inspected directly; none was discarded or changed.

The machine-readable authority for file-level approval, conflicts, risk and ordering is
[`approved-files-conflict-risk-manifest.json`](./approved-files-conflict-risk-manifest.json).

## Outcome

- No file bypasses the controller lifecycle. Thirty-six exact files are evidence-approved: the complete
  16-file W3 bundle is pair-accepted and policy-eligible after ledger reconciliation; 20 files are
  selective evidence from lanes whose bundles remain rejected.
- W3 is the only remediation whose evidence package is internally complete. The corrected W3/W5 review
  accepts all 16 W3 files together; its estimate remains an input requiring controller deduplication.
- The pair-approved original W1 selection/reconciliation record must be retained. W1 remediation
  replaced it with a shorter, weaker summary; the corrected W1/W2 review still rejects both bundles.
- Eight W2 files are selectively approved. Environment omission detection, three provider proofs and
  the stale handoff keep W2 rejected.
- Four W5 evidence files are selectively approved. Fresh effect recovery, independent census coverage,
  ownership/direction, handoff and whitespace findings keep W5 rejected.
- Six W4 and one W6 files are selectively approved. The corrected W4/W6 review rejects both bundles.

## Corrected pair-review dispositions

- W1/W2 v3: remediate both; nine selective file approvals. This audit selects the stronger original W1
  invariant hash rather than the shortened remediation version at the same path.
- W3/W5 v2: adopt all 16 W3 files; remediate W5; four selective W5 evidence approvals.
- W4/W6 v2: remediate both; seven selective file approvals.

## Acceptance-critical conflicts

1. W4 emits `protocolVersion/runtimeGeneration/residualCount`; W6 requires a different invented drain
   record containing purpose, reset/deployment/anchor generations, classification and residuals. Reset
   fencing is not end-to-end until one shared DTO is emitted and consumed.
2. W4 specifies native binaries under `/opt/agent-teams/bin/*`; W6 specifies `/app/bin/*`. W6 also omits
   W4-required protocol/build/compiler/ABI/UID/GID/mode metadata while reporting the contract valid.
3. W1 and W2 assign launch/stop/delete to `team.lifecycle`; W5 assigns launch/stop/cancel to
   `team-runtime-control` and preserves legacy `runtime.permission_answer` direction.
4. W1's remediation scans 106 sites in four files. The same scanner finds 649 additional interaction
   sites in 131 other team-component files, so the exhaustive visible-control claim is unproved.
5. Estimate files share a basename but not a unit or additive contract. W2/W4 and W3/W5 ranges overlap
   and must be replaced/deduplicated by the controller.
6. W2's environment check passes its own test but misses eight one-key omissions; three required
   provider cases remain explicit gaps rather than completed proof.
7. W5 effect recovery invokes `recover()` inside the crashed closure and resumes the old control path;
   it does not reload durable state into a fresh recovery machine.

## Narrow verification

- W2 scanner: pass.
- W3 production `TeamBackupService` fault suite, evidence verifier and architecture test: pass.
- W4 marker-owned current-host probe: pass as characterization; final topology is false and PID reuse
  was not deterministically forced. Corrected review also found the stale W4 Vitest expectation fails.
- W5 evidence freshness check and seven focused tests: pass at their scope; corrected review found two
  no-index whitespace failures and the fresh-recovery gap.
- W6 revocation restart model and local verifier: pass; independent W4/W6 contract comparison rejects
  compatibility, and corrected-review targeted lint fails import ordering.

No broad/final gate, integration, push, Phase 1 work, terminal implementation or real-project/provider
test was performed.
