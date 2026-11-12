import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInstallFailureTracker,
  isRetryableInstallFailure,
} from '../../scripts/ci/install-dependencies-with-retry.mjs';

test('long unfinished engine warning does not turn a transient 503 into a terminal failure', () => {
  const tracker = createInstallFailureTracker();
  tracker.observe('stderr', '[WARN] ' + 'x'.repeat(600));
  tracker.observe('stderr', ' Unsupported engine\nERR_PNPM_FETCH_503\n');
  assert.deepEqual(tracker.snapshot(), {
    retryableFailureSeen: true, terminalFailureSeen: false,
  });
});

test('next fatal engine line is not masked by a prior long warning', () => {
  const tracker = createInstallFailureTracker();
  tracker.observe('stderr', '[WARN] ' + 'x'.repeat(600) + ' Unsupported engine\n');
  tracker.observe('stderr', 'Unsupported ');
  tracker.observe('stderr', 'engine\nERR_PNPM_FETCH_503');
  assert.deepEqual(tracker.snapshot(), {
    retryableFailureSeen: true, terminalFailureSeen: true,
  });
});

test('404 marker fragmented across chunks within one stream is terminal', () => {
  const tracker = createInstallFailureTracker();
  tracker.observe('stderr', 'ERR_PNPM_FETCH_4');
  tracker.observe('stderr', '04\nERR_PNPM_FETCH_503');
  assert.deepEqual(tracker.snapshot(), {
    retryableFailureSeen: true, terminalFailureSeen: true,
  });
});

test('separate output streams cannot fabricate a 404 marker', () => {
  const tracker = createInstallFailureTracker();
  tracker.observe('stdout', 'ERR_PNPM_FETCH_4');
  tracker.observe('stderr', '04\n');
  tracker.observe('stdout', '\nERR_PNPM_FETCH_503');
  assert.deepEqual(tracker.snapshot(), {
    retryableFailureSeen: true, terminalFailureSeen: false,
  });
});

test('whole-output classifier distinguishes long warning from fatal engine', () => {
  assert.equal(isRetryableInstallFailure(
    '[WARN] ' + 'x'.repeat(600) + ' Unsupported engine\nERR_PNPM_FETCH_503'
  ), true);
  assert.equal(isRetryableInstallFailure('Unsupported engine\nERR_PNPM_FETCH_503'), false);
});
