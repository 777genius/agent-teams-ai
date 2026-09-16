# Phase 0 reciprocal review: W4 / W6

- Review ID: `P0.R46.RECIPROCAL_REVIEW`
- Packet revision: `phase-00-r2`
- Phase start SHA: `a32f509e6d9bd31ba2135940e336729bf90c3d93`
- Producer worktrees: `phase-00-w4-lease-guard-process-v1`,
  `phase-00-w6-auth-proxy-artifacts-v1`
- Review status: `rejected_pending_correction`

## Dispositions

| Producer   | Disposition                   | Reason                                                                                                                                                                                                                                            |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W4         | **Reject for adoption**       | The lane correctly stays `characterized`, remains in scope, and has useful current-host probes, but its descendant signaling contradicts ADR-31's no-numeric-PID fallback and its cleanup/FD-closure evidence overclaims what the harness proves. |
| W6         | **Reject for adoption**       | The artifact gaps are usefully characterized, but the auth model restores mutation admission after logout/family revocation on restart, and reset is not bound to W4 typed drain evidence.                                                        |
| W4/W6 pair | **Reject paired integration** | The proposed artifact scan does not inventory the three required W4 binaries/manifests or prove their final init/seccomp/image placement, and auth reset can proceed without a W4 `drained` outcome.                                              |

The unavailable final-shape topology is not itself a producer defect: both handoffs correctly use
`characterized`, not `verified`. It remains a mandatory post-correction target-host gate.

## Actionable findings

### R46-01 — critical — W6 restart resurrects revoked authority

- Evidence: `scripts/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.mjs:71-75`
- Contradicted claims: `docs/research/hosted-web/phase-0/auth-artifacts/report.md:9-13` and
  `docs/research/hosted-web/phase-0/auth-artifacts/evidence.json:22-31`
- Affected evidence/decisions: `P0.W6.AUTH_TRANSITIONS`, ADR-7.
- Finding: `restart` sets `mutationAdmission` from keyring readiness and the mere presence of
  `device.familyRef`. It does not require an active, unrevoked session or an unrevoked device. A focused
  reviewer reproducer observed `authority_reloaded` and `mutationAdmission=true` after session logout,
  `forget_device`, and replay-family revocation.
- Required correction: separate auth-storage readiness from request mutation admission. Recompute
  admission only from a valid unrevoked session; keep expired/logged-out sessions closed until device
  renewal and keep revoked/reset families closed across restart. Add restart schedules after expiry,
  logout, forget-device, replay-family revoke, and every reset stage.

### R46-02 — high — W6 reset is not fenced by W4 drain truth

- Evidence: `scripts/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.mjs:128-145` and
  `test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts:88-110`
- Cross-lane evidence: `scripts/hosted-web/phase-0/host-primitives/process-anchor/process_anchor_spike.c:323-329`
- Affected evidence/decisions: `P0.W6.AUTH_TRANSITIONS`, `P0.W4.PROCESS_ANCHOR_SPIKE`, ADR-7, ADR-31.
- Finding: reset accepts a caller-set integer `runtimeCount=0`; it carries no anchor nonce/generation,
  reconciliation identity, or typed `drained` proof and cannot distinguish W4's
  `unclassified_residual`. This violates the ADR-7 requirement that reset issue no plaintext challenge
  until all live/unclassified runtimes are resolved.
- Required correction: model a generation-bound W4 reconciliation result and permit reset advancement
  only on a current typed `drained` outcome. `unclassified_residual`, missing evidence, stale nonce, or
  anchor failure must keep admission/challenge issuance closed and require whole-container replacement.

### R46-03 — high — W4 signals descendants through reusable numeric PIDs

- Evidence: `scripts/hosted-web/phase-0/host-primitives/process-anchor/process_anchor_spike.c:129-224`
- Contradicted claim: `docs/research/hosted-web/phase-0/host-primitives/process-anchor-spike.md:8-9`
- Affected evidence/decisions: `P0.W4.PROCESS_ANCHOR_SPIKE`, ADR-31.
- Finding: only the main child is signaled through a pidfd. Descendants are discovered from `/proc`,
  then later passed to raw `kill(pid, signal)`. Exit/PID reuse between inspection and signal can target
  an unrelated process; the unrelated `sleep` canary does not exercise reuse. ADR-31 explicitly rejects
  PID/start-token recheck followed by `kill`/`killpg` as non-atomic.
- Required correction: target every signal through a kernel-stable ownership primitive. Prefer the
  live anchor's allocated process group for in-group children and pidfds for any individually targeted
  descendant; treat an escaped/ambiguous tree as unclassified and use the container boundary. Add the
  required rapid PID/PGID reuse negative schedule before claiming zero unrelated signals.

### R46-04 — high — W4 cleanup evidence is emitted before cleanup and hard-coded

- Evidence: `scripts/hosted-web/phase-0/host-primitives/run-native-probes.py:571-593`
- Overstated record: `docs/research/hosted-web/phase-0/host-primitives/current-host-probe-results.json:2-5`
- Affected evidence: all executable W4 spike records.
- Finding: the runner serializes `markerRemoved: true` while the marker still exists, hard-codes
  `ownedResidualProcesses: 0`, and only afterward calls `shutil.rmtree(..., ignore_errors=True)`. A
  failed removal or untracked residual cannot fail the run, so this is not marker-owned cleanup proof.
- Required correction: track every spawned PID/PGID, perform and verify cleanup before emitting success,
  fail on removal errors, verify the marker path is absent and no owned process remains, and generate
  the checked-in result from that verified output rather than manually projecting success fields.

### R46-05 — medium — W4 close-all proof has a fixed descriptor ceiling

- Evidence: `scripts/hosted-web/phase-0/host-primitives/workspace-guard/workspace_guard_spike.c:150-153`
  and `scripts/hosted-web/phase-0/host-primitives/process-anchor/process_anchor_spike.c:79-81,255-258`
- Affected evidence/decisions: `P0.W4.WORKSPACE_GUARD_SPIKE`, `P0.W4.PROCESS_ANCHOR_SPIKE`, ADR-28,
  ADR-31.
- Finding: the fixtures close only FDs 3 through 1023 while the evidence says all non-stdio or
  undeclared descriptors are closed. A lease/control descriptor duplicated above 1023 would survive.
- Required correction: use an admitted `close_range`/`/proc/self/fd` implementation that preserves an
  explicit FD map, and add a negative fixture with lease/control canaries above 1023.

### R46-06 — high — W6's artifact gate cannot prove the W4 final image contract

- Evidence: `scripts/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.mjs:239-323`
- Cross-lane requirements: `docs/research/hosted-web/phase-0/host-primitives/native-artifact-proposal.md:5-19`
  and `docs/research/hosted-web/phase-0/host-primitives/target-host-envelope.md:29-40`
- Affected evidence/decisions: `P0.W6.ARTIFACT_INVENTORY`, `P0.W6.ABI_STUB_REPORT`, all W4 evidence,
  ADR-16, ADR-17, ADR-28, ADR-31.
- Finding: the scan inventories the server CJS graph, internal-storage worker, generic stubs, and
  terminal markers, but has no required rows for the instance-lock launcher, workspace guard, process
  anchor, their protocol/build hashes, init ordering, stripped/no-compiler image placement, or their
  final UID/seccomp probe results. W4 consequently has no concrete W6 artifact topology to verify.
- Required correction: extend the proposed hosted artifact manifest and negative scanner with all three
  W4 artifacts/manifests, launcher-before-Node/init ordering, final-image syscall/readiness probes, and
  absence of compiler/source artifacts. W4 must rerun marker-owned probes against that exact image.

### R46-07 — medium — W6 ABI/native smoke claims are not reproducible from owned code

- Evidence: `docs/research/hosted-web/phase-0/auth-artifacts/evidence.json:177-240`
- Missing coverage: `scripts/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.mjs:239-323` and
  `test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts:178-205`
- Affected evidence: `P0.W6.ABI_STUB_REPORT`.
- Finding: the evidence records Node/Electron ABIs and two SQLite smoke-query results, but no owned
  scanner/test emits or checks those facts and the handoff contains no exact smoke command. The current
  verifier validates schema and artifact-scan freshness only.
- Required correction: add deterministic ABI/package-resolution and native-load probes with exact
  commands and assertions. Keep Electron/final-image loads explicitly unverified until run in those
  runtimes.

### R46-08 — low — producer `git diff --check` records did not cover untracked output

- Evidence: every W4 and W6 owned file is untracked, while both handoffs record only
  `git diff --check`.
- Affected evidence: both self-review handoffs.
- Finding: plain `git diff --check` returned success without inspecting an untracked file. The reviewer
  separately ran `git diff --no-index --check /dev/null <file>` for every owned file and found zero
  whitespace errors, so this is a provenance defect rather than a current whitespace defect.
- Required correction: record a diff-check that covers every untracked path, or run the standard check
  after the integration owner has materialized the candidate diff.

## Scope, secret, and evidence audit

- W4: 15 changed paths, 1,916 lines. All paths are within the W4 lane surfaces or its local handoff.
  The handoff correctly requests split adoption because this exceeds the 1,500-line ceiling.
- W6: 9 changed paths, 1,431 lines. All paths are within the W6 lane surfaces or its local handoff.
- Neither producer changed production source, package manifests, lockfiles, Docker entrypoints, another
  lane, or Phase 1 code.
- A reviewer scan across every owned file found no private-key marker, bearer/token prefix, private
  home path, `.claude` path, or real-project path. The fixtures use only fresh `/tmp`/test-owned data.
- Both producer handoffs use the correct base SHA, packet revision, evidence IDs, and
  `status=characterized`. Their final-topology claims remain explicitly unverified.

## Reviewer checks

No broad CI was run and neither producer worktree was modified.

| Check                                                | Result                                                  |
| ---------------------------------------------------- | ------------------------------------------------------- |
| W4 native probe runner                               | pass; current host remained `finalShapeContainer=false` |
| W4 two owned Vitest files                            | pass, 3 tests                                           |
| W4 evidence scanner and JSON parse                   | pass                                                    |
| W4 targeted ESLint, no cache                         | pass                                                    |
| W6 owned Vitest file                                 | pass, 17 tests                                          |
| W6 evidence/schema/freshness verifier and JSON parse | pass                                                    |
| W6 targeted ESLint, no cache                         | pass                                                    |
| All untracked files, independent no-index diff-check | pass, zero whitespace errors                            |
| Reviewer auth revocation/restart reproducer          | fail as expected; reproduced R46-01 in all three cases  |
| Reviewer secret/path scan over all owned files       | pass, no findings                                       |

The producer Vitest commands were executed with this writable review worktree's equivalent root config
because Vite could not create `.vite-temp` in the read-only producer worktrees. Test discovery and test
working directories remained the producer worktrees. Direct producer `lint:fast:files` likewise could
not write its cache, so the same target files were linted with the same fast config and `--no-cache`.

## Correction order

1. Fix R46-01 and R46-02 before relying on W6 auth evidence.
2. Fix R46-03 and R46-04 before relying on W4 process/cleanup safety claims.
3. Reconcile the concrete W4 artifact/topology manifest in W6 (R46-06).
4. Fix R46-05, R46-07, and handoff diff-check provenance.
5. Rerun targeted checks, repeat reciprocal review, then run the corrected probes in the admitted
   final-shape topology. Do not start Phase 1 from the current dispositions.
