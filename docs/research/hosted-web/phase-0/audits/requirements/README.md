# Phase 0 requirement-to-evidence acceptance audit

- Audit ID: `P0.AUDIT.REQUIREMENTS.V1`
- Packet: `phase-00-r2`
- Phase start: `a32f509e6d9bd31ba2135940e336729bf90c3d93`
- Registry snapshot: `2026-07-11T18:21:15Z`
- Disposition: **reject pending correction and reciprocal re-review**

## Outcome

Phase 0 is not acceptable for adoption or freeze. The project registry proves that all six producer
jobs and all three reciprocal review jobs completed, but every producer lane was rejected by its
assigned reciprocal review. There are zero approved lanes. No correction attempt or focused re-review
is present.

The requirement matrix contains 70 checks:

| Status      | Count | Meaning in this audit                                                   |
| ----------- | ----: | ----------------------------------------------------------------------- |
| `satisfied` |    17 | Current authoritative evidence proves the bounded requirement.          |
| `partial`   |    14 | Useful evidence exists but is weaker or narrower than required.         |
| `failed`    |    28 | Evidence contradicts the requirement or reciprocal review rejects it.   |
| `missing`   |     5 | The required proof, usually final-topology proof, does not exist.       |
| `pending`   |     6 | A 0D/freeze deliverable cannot proceed while lane evidence is rejected. |

The machine-readable authority is
[`requirement-matrix.json`](./requirement-matrix.json). The registry/worktree mapping, completion
states and SHA-256 evidence snapshot are in [`registry-snapshot.json`](./registry-snapshot.json).
Matrix references resolve as follows: `Wn_HANDOFF` and `Wn:<evidence-id>` use the matching
`producerJobs[laneId=wN]` workspace/handoff; `R12`, `R35` and `R46` use the matching `reviewJobs`
record and hashed report; the remaining uppercase names use the `sources` array.

## Acceptance-critical findings

### W1 / W2

The W1/W2 review rejects both lanes.

- W1's 86/20/3 AST count and selection/reconciliation invariants are useful, but the action inventory
  is not a semantic action ledger. It manufactures one action per JSX site, includes non-actions such
  as `stopPropagation`, assigns ownership from heuristics and hashes source line/location into
  supposedly stable IDs (`R12-W1-001`, `R12-W1-002`, `R12-X-001`).
- W1's estimate reports incorrect net comparisons and suppresses a greater-than-20-percent variance.
  Its 48,661-line output also violates the evidence/adoption budget without an approved split or
  external raw-artifact treatment (`R12-W1-003`, `R12-W1-004`).
- W2 correctly separates four provider identities from two backend families, but environment
  completeness is not scanned from source and known explicit keys are absent (`R12-W2-001`).
- W2's generic schema does not require the ingress authority/idempotency/body/evidence fields that the
  packet makes acceptance-critical. Its negative fixture tests only route removal/duplication
  (`R12-W2-002`). The fake-provider matrix is incomplete and estimate IDs do not map to the canonical
  `EST-LIFECYCLE-RUNTIME` bucket (`R12-W2-003`, `R12-W2-004`).

### W3 / W5

The W3/W5 review rejects both lanes.

- W3's state-family catalog, writer matrix, external-writer negative control and WAL Online Backup
  spike are useful at their stated proof levels. `TeamBackupService`, however, was never exercised by
  the required fault-injected fixture; the current behavior record is source deduction only
  (`RW35-001`).
- W5 counts commit, compensation and event-publication trace labels as if they were real crash/restart
  transitions (`RW35-002`). Its claimed convergence and no-duplicate-effect result therefore does not
  cover the required boundaries.
- W5 marks task/inbox effects idempotent despite W3 proving active writer coordination and durable
  lookup unproven (`RW35-003`). Its fingerprint vectors omit fingerprint-version and default/omission
  cases (`RW35-004`), and its mutation census is circular (`RW35-005`).

### W4 / W6

The W4/W6 review rejects both lanes and paired integration.

- No required W4 proof ran in the admitted final Debian-slim, non-root, init/seccomp/volume topology.
  Two final-image containers plus the manual contender were not exercised.
- The process anchor signals descendants through reusable numeric PIDs, contrary to ADR-31
  (`R46-03`). Cleanup success/zero residuals are hard-coded before ignored cleanup (`R46-04`), and FD
  closure stops at descriptor 1023 (`R46-05`).
- W6's auth model restores mutation admission after logout, forget-device and replay-family
  revocation on restart (`R46-01`). Reset trusts a caller-provided count rather than a generation-bound
  W4 `drained` result (`R46-02`).
- The current standalone artifact omits the internal-storage worker, retains catch-all native/Electron
  stubs and terminal service/package surfaces, and has no manifest rows for the three W4 native
  artifacts (`R46-06`). Recorded ABI/native smoke facts have no owned reproducible command or assertion
  (`R46-07`).

## Cross-cutting gaps

The bootstrap evidence is not literally closed: `lint:fast` and `standalone:build` were not captured,
the nested typecheck/test stages lack independent duration/tail records, and there is no post-fix broad
rerun before lane admission. The checked-in lane ledger also remains at six `unstarted` slots with null
job IDs and phase start even though the registry now records nine completed jobs.

The estimate cannot be frozen. The shared ledger is still the pre-inventory 28k-45k baseline; W1 has
incorrect arithmetic, W2 uses noncanonical bucket IDs, W3/W5 overlap is not reconciled, and W4's native
sub-buckets have no controller mapping. There is no evidence-backed answer yet to whether 28k-45k
remains credible.

All final-topology claims remain open: instance lease, workspace guard, process ownership, HTTPS
proxy/auth schedules, Node/Electron/final-image native loading, W4 native packaging and terminal-free
artifact composition. These are mandatory proof gaps, not later release niceties.

The decision register contains only 0A outcomes. It does not record the reciprocal rejections,
contested findings, reopened ADRs or any of the required freeze decisions. Combined targeted checks,
the 0D broad gate, completion report and Phase 1 JIT packet are therefore not ready to run or create.

## Evidence that can be retained

The rejection does not make every artifact useless. The following are bounded, reviewed inputs for a
correction attempt:

- the W1 86/20/3 AST census, dynamic-dispatch negative control and selection/reconciliation invariants;
- the W2 four-provider/two-backend topology and five current runtime-ingress observations, after
  schema and completeness repair;
- the W3 17-family catalog, 12-operation writer matrix, external-writer negative control and current-
  host WAL Online Backup feasibility result;
- W5's two deliberate lost-event negative controls and current-surface inventory, not its exhaustive
  or retry-safety claims;
- W4's current-host negative controls as characterization only, after fixing process targeting,
  cleanup and high-FD closure;
- W6's current artifact defect inventory and proxy ordering model, not its restart-safe auth or final
  artifact claims.

## Required correction order

1. Return R12 findings to W1/W2. Replace heuristic action generation with a reviewed semantic catalog,
   make IDs source-location independent, discover environment inputs from source, enforce artifact-
   specific schemas, correct estimate inputs and compact/externally hash oversized raw evidence.
2. Return RW35 findings to W3/W5. Add the marker-owned `TeamBackupService` fault suite; model every
   scheduler boundary as a real durable crash/restart transition; default unproved writer effects to
   `operator_required`; use an independent mutation census and complete retained-version goldens.
3. Return R46 findings to W4/W6. Fix revoked-session restart and typed-drain reset fencing; remove
   numeric-PID descendant signaling; measure cleanup; close the complete FD range; add the three W4
   artifacts and reproducible ABI probes to the hosted manifest/scanner.
4. Repeat all three reciprocal reviews. A lane remains rejected until its owner-generated evidence and
   focused re-review close or explicitly contest every finding.
5. Reconcile the canonical unique estimate buckets, record every decision/rejection/reopened ADR in the
   controller register, then run the exact admitted final image/edge topology proofs.
6. Only after accepted adoption may the controller run combined/final gates, freeze Phase 0 and
   generate the Phase 1 JIT packet.

## Audit boundaries

This audit was read-only outside its owned directory and local handoff. It did not modify producer,
review or integration worktrees; it did not run broad/final gates, integrate output, contact a real
provider/project, or implement Phase 1. Reviewers' targeted command results are treated as evidence only
at the scope they exercised; passing tests do not override the reciprocal findings that those tests are
shallow, circular or missing required schedules.
