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

## Baseline observations

- `43635094963`: Windows x64 failed the synthetic saved-model fixture; Darwin
  x64 failed the pending-source fixture before later process steps.
- `43635095040`: thirteen Electron lanes were queued when this continuation
  started; this is not acceptance evidence.
- Provider source `421fee918811b8a0b0c73d0ff3e761b9a1c5ecb0` is already the
  frontend's checked archive. Source/packed provider checks do not establish
  Desktop acceptance.
