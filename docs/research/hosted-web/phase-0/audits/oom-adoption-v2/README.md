# Phase 0 OOM preservation and adoption audit v2

## Decision

Preserve every producer. Adopt only the completed W3 remediation through the controller policy
lifecycle. Reject all six original producers as already recorded in the consumed-output ledger. Continue
the OOM-stopped W1, W2, W4, W5 and W6 remediations from their exact dirty trees; none is a completed job
and none is directly adoptable.

The machine-readable authority for exact classifications, worktree digests, preservation file lists,
approved W3 hashes, overlaps and lifecycle order is `candidate-manifest.json`.

| Candidate      | Registry/worktree truth                        | Classification | Integration-approved files |
| -------------- | ---------------------------------------------- | -------------- | -------------------------: |
| Original W1    | done, dirty output, consumed ledger rejected   | reject         |                          0 |
| Original W2    | done, dirty output, consumed ledger rejected   | reject         |                          0 |
| Original W3    | done, dirty output, consumed ledger rejected   | reject         |                          0 |
| Original W4    | done, dirty output, consumed ledger rejected   | reject         |                          0 |
| Original W5    | done, dirty output, consumed ledger rejected   | reject         |                          0 |
| Original W6    | done, dirty output, consumed ledger rejected   | reject         |                          0 |
| Remediation W1 | OOM-stopped, 13 dirty files, no result         | remediate      |                          0 |
| Remediation W2 | OOM-stopped, 18 dirty files, no result         | remediate      |                          0 |
| Remediation W3 | strict result `done`, 16 dirty files           | adopt          |                         16 |
| Remediation W4 | OOM-stopped, 21 dirty files, no handoff/result | remediate      |                          0 |
| Remediation W5 | OOM-stopped, 17 dirty files, no result         | remediate      |                          0 |
| Remediation W6 | OOM-stopped, 11 dirty files, no result         | remediate      |                          0 |

`adopt` means eligible for a new controller-owned lifecycle attempt, not integrated by this audit. The
audit did not open an integration attempt, edit a producer, commit, push, run a broad/final gate, start
Phase 1, or implement terminal behavior.

## OOM and preservation truth

The controller signal at `2026-07-11T19:00:21.921Z` states that global OOM with no swap killed W1, W2,
W4, W5, W6 and the W3 fastgate, requires `preservePatch=true`, and forbids treating dirty worktrees as
completed. Registry/job evidence agrees:

- W1, W2, W4, W5 and W6 retain stale `running` progress records and have no latest-result record.
- W3 alone has `latest-result.status=done`, one completed attempt and the same 16 paths found directly in
  its worktree.
- The five stopped jobs have useful output, so rejecting or recreating their worktrees would discard
  recoverable work. Their exact path sets and aggregate tree digests are frozen in the manifest.
- The old review/audit manifests had ineffective read scope (only their own workspace plus registry).
  Corrected v2/v3 manifests read the project worktrees root while retaining isolated write roots. At
  audit completion, all three corrected pair-review worktrees contained dirty, nonterminal drafts. This
  audit inspected those drafts directly, reproduced their important checks, and incorporated their
  findings, but did not edit or present them as terminal registry results. They classify W1/W2 and W4/W6
  as remediate, W3 as adopt, and W5 as remediate.

The original outputs remain preserved at their consumed-ledger backup paths. Nine original evidence
files were historically accepted as useful, but the pair-level reviews and consumed ledger rejected all
six original jobs. One current contradiction must stay explicit: cross-lane-v2 prefers the original
137-line W1 selection-invariant hash, while the corrected pair/completion reviews approve its 28-line
remediation replacement. The manifest records both hashes; neither is integration-approved until the
controller resolves that exact-file conflict.

## Candidate findings

### W1

The remediation replaces line-dependent JSX manufacture with 30 reviewed semantic actions, 95 direct
API bindings and three deliberate-absence classes. `team.lifecycle.stop` is owned by team lifecycle;
provider credential/auth actions are owned by runtime-provider-management. The evidence is compact: 13
files and 591 physical lines. The 610-row raw bypass projection is reproducible from the generator and is
bound by SHA-256 `2ea065639675df126935790d86578cfdae9cf9feb60371826b03f1f877c5f497`.

Seven focused tests pass. A marker-owned `/tmp` regeneration reproduced the API ledger, action inventory
and estimate byte-for-byte and reproduced the raw hash; only the raw artifact's declared external path
changed with the temporary root. The passing gate is incomplete: it hard-codes four composition files
and omits reachable child controls such as the five interaction sites in `TeamListFilterPopover`. The
synthetic missing/duplicate fixture cannot detect that omission, and 11 W1 files fail the repository
format check. The job also has no terminal result and its handoff records the phase start as `baseSha`
instead of the actual remediation base. Pair/completion review approves the remediation selection
document, but cross-lane-v2 rejects it as a weaker rewrite and prefers the original hash. Continue the
lane, restore or strengthen the invariant record, close the child-control closure, format it, regenerate
the handoff and repeat review.

### W2

The remediation scanner now discovers environment tokens from 17 bounded source surfaces, compares 90
classified keys, enforces artifact-specific nested schemas, covers 13 provider rows, separates browser
and runtime authority, and maps its range to canonical `EST-LIFECYCLE-RUNTIME`. The scanner and eight
focused tests pass, but the stronger omission probe fails: eight explicit classified keys can be removed
without a completeness diagnostic. Three required provider rows (`malformed_capability_response`,
`restart_adoption`, and `opencode_secondary_lane_recovery`) still have neither positive nor negative
proof, so the matrix is an honest gap ledger rather than a complete fixture matrix.

The handoff is stale: it omits five new schema files, still lists the removed generic schema, identifies
the phase start rather than remediation base, and has no terminal result. Eight topology/ingress/exposure
and estimate files are useful-only approved at exact hashes in the manifest. Preserve all 18 files, fix
the environment and provider proof gaps, finish the handoff/result and repeat W1/W2 review.

### W3

Approve all 16 files at the hashes in the manifest. The completed remediation retains the previously
useful state/writer/SQLite evidence and adds a marker-owned suite that constructs production
`TeamBackupService`. Seven tests cover twelve readiness, enumeration, identity, copy, pruning,
publication, registry and restore cases while honestly retaining `legacy_unverified` for the service.
The W3 verifier and architecture test pass; the existing WAL Online Backup proof remains scoped to the
current host and no final-image/production-worker claim is made.

W3 is 2,454 lines, so the lifecycle must use the three recorded sub-1,500-line splits in one attempt.
W3's 4.5k-7.25k estimate overlaps W5; adopt it as an input, never add it to W5's 4.5k-7.5k range.

### W4

The preserved W4 work is meaningful. Its current-host probe now reports verified cleanup before
emission, 146 tracked identities, 106 tracked groups, zero residuals, high-FD closure, process-group
signaling, typed `drained`/`unclassified_residual` outcomes and no unrelated signal. The direct probe
rerun passed, while correctly reporting `finalShapeContainer=false` and that PID reuse was not
deterministically forced. The full owned test pair is not green: one test retains the old two-field
cleanup equality and fails against the new measured record.

It is not adoptable: the anchor replaces raw descendant PID signals with `kill(-owned_pgid, ...)`, but an
escaped residual can leave that numeric process group empty before the second KILL and allow PGID reuse
to target an unrelated group. The markdown claim of pidfd signaling is therefore false. No handoff or
result exists; final image/two-container evidence remains absent; its `host.*` estimate rows are not
mapped to W2's canonical bucket; and the W4/W6 native contract conflicts. Six lease/guard/envelope files
are useful-only approved at exact hashes in the manifest. Preserve all 21 files and continue the lane.

### W5

The dirty remediation improves snapshot schedules, fingerprint version/default vectors and writer
truth. All 103 effects now keep automatic recovery closed where W3 cannot prove coordination. The
generator check and seven focused tests pass. Four records are useful-only evidence at their declared
proof levels: event cursor inventory, snapshot scheduler, fingerprint goldens and estimate. Their exact
hashes are in the manifest; they are not integration approval for the lane.

Five blockers remain:

1. Effect recovery snapshots state, records crash/restart labels, calls recovery in the same closure and
   resumes the pre-crash runner. It does not instantiate a fresh durable recovery machine.
2. The mutation census is separate from command descriptors but defined in the same generator; deleting
   or forgetting a census row removes both the artifact and the obligation. No independent source
   extraction or omitted-row fixture proves completeness.
3. The handoff omits both mutation-census files, reports the wrong base and has no strict result.
4. No-index checks report extra blank lines in `.codex-handoff/phase-00-w5.json` and
   `fixtures/invalid-command-catalog.json`.
5. The census assigns launch/stop/cancel to `team-runtime-control` and keeps
   `runtime.permission_answer` as a hosted mutation, contradicting W1/W2 canonical ownership and
   permission direction.

Preserve all 17 files, remediate from that state, then repeat W3/W5 review.

### W6

The stopped remediation materially fixes the original restart/auth model: mutation admission requires
an active unrevoked session, restart schedules keep logout/family revocation closed, and reset requires
typed generation-bound drain evidence. The verifier and 25 focused tests pass. It also adds ABI probes,
a proposed nine-row artifact manifest and a negative terminal gate. Those greens overstate the pair:
the verifier returns success for the contradictory/incomplete W4 contract, and targeted fast lint fails
the W6 test import order.

It remains nonterminal and internally honest that the current standalone artifact is not the hosted v1
artifact. The handoff omits the finding-resolution and proposed-manifest files and reports the wrong
base; the finding-resolution record falsely marks the drain/artifact-contract findings resolved. Only
the reproduced current-artifact scan is useful-only approved. Preserve all 11 files, reconcile the pair
and repeat review.

## Cross-lane compatibility

There is no dirty-path overlap among the six remediation worktrees. Semantic overlap is the real gate:

- W1/W2: the original stop/provider ownership contradiction is closed in content. Both stopped outputs
  still need correct handoffs, strict results and focused review.
- W2/W6: browser-session authority and machine runtime ingress are disjoint in the dirty evidence, but
  nonterminal handoffs cannot freeze the decision.
- W3/W5: writer/recovery semantics agree. W5 defaults unproved task/inbox/provider effects to
  `operator_required`; the estimate ranges overlap and must be deduplicated. Command ownership does not
  yet agree: W5 labels launch/stop/cancel as `team-runtime-control` and retains
  `runtime.permission_answer`, contradicting W1/W2 `team.lifecycle` ownership and request-ingress plus
  operator-outbound permission direction.
- W2/W4: W2 declares one `EST-LIFECYCLE-RUNTIME` replacement range and excludes W4 primitives, while W4
  still uses unmapped `host.*` records. Do not add the ranges.
- W4/W6: W4 requires binaries at `/opt/agent-teams/bin`; W6 declares `/app/bin`. W6 also omits W4's
  required protocol/build/builder/compiler/UID/GID/mode fields. W6's adapter-level
  `process_drain_outcome_v1` is not schema/hash-mapped to W4's raw process-anchor response. These are
  adoption blockers, not naming polish.

## Safe ordered lifecycle

1. Before any reconcile/restart/cleanup, capture immutable patch, status, path list and tree digest for
   every remediation worktree. Do not recreate producer worktrees.
2. Record that W3's estimate is a non-additive input to `EST-RECOVERY-STATE` and does not freeze or add to
   W5's range. Then open one controller policy integration attempt for exact W3 digest
   `0f0aeca56e4c2b9363ae557b72dcab2d27c794e7f2dc99306a9ceb3704ac5ce2`. Adopt its scripts/tests,
   evidence and handoff as the three manifest splits; verify every hash and rerun only W3 checks.
3. Continue W1 and W2 from preserved state, regenerate accurate handoffs/results, repeat W1/W2 review,
   then adopt W1 before W2 only if the review accepts both.
4. Continue W5 against adopted W3 truth. Add a fresh durable recovery runner, independent mutation
   census and omission controls; fix provenance/whitespace; repeat W3/W5 review before W5 adoption.
5. Reconcile W4/W6 paths, manifest fields, typed-drain schema/hash mapping and W2/W4 estimate ownership.
   Complete both jobs, repeat paired review, and adopt W4 before W6 only if accepted.
6. Reconcile controller lane ledger, decision register and unique-bucket estimate only after accepted
   lane adoptions. Final-image/HTTPS/container probes and any broad/final repository gate remain later,
   separately authorized work.

## Narrow verification

| Check                                                                    | Result                                                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| All Phase 0 worktree HEAD/status surfaces                                | inspected; producers preserved; this audit edited none                                   |
| Registry manifests, job progress/results, consumed ledger and OOM signal | inspected                                                                                |
| W1 read-only Vitest                                                      | 7/7 pass; omitted-child coverage probe fails                                             |
| W1 temporary deterministic regeneration                                  | API/action/estimate equal; raw hash equal                                                |
| W2 scanner                                                               | passes current rules: 4 providers, 2 backend families, 5 operations, 13 rows             |
| W2 read-only Vitest                                                      | 8/8 pass; exhaustive key-removal probe fails for 8 keys                                  |
| W3 production-service fault suite                                        | 7/7 pass, 12 cases                                                                       |
| W3 verifier and architecture test                                        | pass                                                                                     |
| W4 current-host native probes                                            | direct runner passes; owned Vitest has 1 stale-cleanup failure; final-shape target false |
| W5 generator and node tests                                              | pass; 7/7, with substantive gaps above                                                   |
| W5 no-index whitespace diagnostics                                       | fail in exactly two named files                                                          |
| W6 verifier                                                              | exits 0 with a false-green pair contract; Node ABI 137, Electron ABI 143                 |
| W6 read-only Vitest / targeted lint                                      | 25/25 tests pass; lint fails import ordering                                             |
| Broad/final gate, integration, Phase 1, terminal implementation          | not performed                                                                            |

Passing focused checks establish only the behavior they exercise. They do not convert a stopped job into
a terminal result or erase the cross-lane contradictions above.
