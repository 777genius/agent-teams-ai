# Remaining Host parity acceptance — 14 November 2026

Baseline: PR #1192, `114255de0bd7f29ac47173bf7f861ff0582c4ae2`.
Continue the existing finite-provider acceptance; retain original failed runs.

## Concrete corrections

1. Use native temporary paths and a controlled Date in the synthetic readiness
   fixture. Preserve the production cutoff and test both sides of that cutoff.
   Use the cross-platform qualified Codex revision in the pending-source fixture.
2. Validate the complete captured Windows batch command by the existing argument
   encoder. Reject appended shell commands while retaining legitimate escaped
   arguments, direct wrappers and single/double escape recipes.
3. Isolate unreadable schedule history during startup. Leave that schedule and its
   bytes untouched, recover healthy schedules, and retain the refusal to replay
   uncertain work. Exercise a real child Host and healthy cron after cold startup.
4. Review Linux warm process retention. Release original descriptors only after
   native absence proof; retain live/unknown custody and bounded owner history.
   Do not weaken cold-owner or stale-capture refusal to reclaim capacity.

Estimated delta: 100–180 production lines and 150–250 focused test lines.
Complexity: 6/10; expected reliability: 9/10; initial confidence: 8/10.

## Review and delivery

- Review 1: reproduce each concrete defect against the baseline; use current
  source to dismiss stale review concerns, not thread age or bot labels.
- Review 2: independently inspect the final diff, original authority/deadline
  boundaries, and meaningful success/failure assertions.
- Build with pinned Node 24.21.0, pnpm 11.22.0 and TypeScript 7.0.2; run the
  affected suites, source-size guard and relevant type checks.
- Commit and immediately publish the reviewed changes to the existing Draft.
- Await original allowed Electron/process workflows on the published source.
  Inspect actual receipts and screenshots; queued/skipped is never success.

Real Codex/Claude executables are excluded. Existing finite peers use disposable
TEST state; the separately declared OpenCode localhost lane remains permitted.
The existing Stage 1 delivery boundary remains unchanged.

## First reviewed correction

Windows launcher/quoting, schedule isolation and both cross-platform fixture
corrections passed independent review. Original failing-before regressions are
retained in the task's verification logs.

- Host and ledger build: PASS with TypeScript 7.0.2.
- Host test types: PASS.
- Windows launch recipes: 8 PASS, 0 skipped; the original code failed the four
  new rejection/argument cases.
- Saved model/readiness: 30 PASS, 0 skipped, including the unchanged expiry cutoff.
- Pending Windows source: 2 PASS, 0 skipped.
- Schedule suites: 62 PASS, 0 skipped, including actual Host/cron cold recovery.
- Focused lint and original source-size/provisioning guards: PASS. Two existing
  `no-unsafe-finally` warnings remain in unchanged SchedulerService code.

Linux lifetime reclamation remains a separate correction: retain natural-exit
history until successful owner purge; retire an explicit Stop capture only after
its durable absence receipt. Never evict an unacknowledged tombstone to make room.
Remote Electron/native execution remains required on the published changes.

## Second reviewed correction

- Linux warm custody closes original descriptors only after native absence. It
  keeps natural-exit history until the exact Team's durable purge and retires
  explicit Stop captures only after their original durable absence receipt.
  Bounded sweeps retain live/unknown captures; the 10,000 bound is outstanding
  unacknowledged custody, not all captures over the Host's lifetime. Purge retry
  repeats private cleanup only, preserving the existing once-only publication.
- A completed Codex installation keeps its installed/ready status when a later
  invalidation/catalog refresh fails. The existing error field and dialog show
  the separate refresh failure; installation analytics and loading remain exact.
- OAuth cancellation observes the original command and opener before its one
  Cancel, then requires that same receipt to release its resource. Runtime boot
  waits for initial session persistence within the existing budget and still
  rejects duplicate or subsequently missing sessions.
- Windows native process assertions retain the original stable registration ID
  across Stop, because stopped metadata changes the content-addressed process
  reference. They still require the original receipt, exact PID, absence,
  disabled termination and untouched live neighbor.
- The Darwin lazy-start fixture uses one absolute deadline from its unchanged
  3-second startup budget, checks early operation completion/rejection and
  preserves post-start context revocation before dispatch. Its delayed-marker
  regression exceeds the unrelated old Vitest 1-second polling default; an
  early-close case proves that a missing marker cannot pass.
- Work-sync assertions enforce the current schema-dependent Team/member fields
  and session-exposed tool names while preserving delivery and wake assertions.
- The Codex finite peer now follows the original frontend's completed-item text
  contract. See plan 13 for current-main runtime 0.0.160 source evidence and the
  distinction between an intermediate message and token streaming. Provider
  source and the checked archive remain unchanged.
- The Desktop aggregate still reports genuine lane failures, but does not run
  after workflow cancellation. The original cancelled 114255de matrix left an
  `always()` aggregate queued, retaining its concurrency group and preventing
  the 8c192631 run from creating any lane jobs. Existing blocked runs require
  separate cancellation or completion; a source fix is not execution evidence.

Independently reviewed verification on the assembled source:

| Scope | Result |
| --- | --- |
| Linux lifetime plus adjacent process/lifecycle suites | 48 PASS, 0 skips; includes 10,005 sequential retirements |
| Original finite Linux C/Node qualification, automatic and explicit warm modes | PASS; both original receipts confirm cleanup |
| Installer store and rendered dialog | 92 PASS, 0 skips; three new regressions failed before correction |
| Work-sync suites | 114 PASS, 0 skips; two obsolete expectations failed before correction |
| Desktop observation/admission tests | 25 PASS, 0 skips |
| Darwin observation mock | 1 PASS; this is not native Darwin qualification |
| Lazy Host startup file | 14 PASS, 0 skips; includes delayed marker and early close |
| Finite Codex child-peer protocol | FAIL before / PASS after; two distinct completed items in one original turn |
| Existing provider Codex protocol/app-server suites | 27 PASS, 0 skips; isolated finite peers |
| Host production build and full Host test types | PASS |
| Legacy Host script types and Windows broker types | PASS |

The exact pnpm 11.22.0 entry and Node 24.21.0 are selected for subsequent
workspace commands; direct Node/compiler tests above do not depend on pnpm.
Original failures and corrected logs remain separate. These constituent
results do not replace the required Electron/native receipts on published
source. In particular, current Electron lanes remain queued/pending, and
additional finite coverage for applicable original UI journeys is under audit.

## Baseline observations

- `43635094963`: Windows x64 failed the synthetic saved-model fixture; Darwin
  x64 failed the pending-source fixture before later process steps.
- `43635095040`: thirteen Electron lanes were queued when this continuation
  started; this is not acceptance evidence.
- Provider source `421fee918811b8a0b0c73d0ff3e761b9a1c5ecb0` is already the
  frontend's checked archive. Source/packed provider checks do not establish
  Desktop acceptance.
