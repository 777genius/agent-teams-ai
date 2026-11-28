import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SNAPSHOT_WARNING_CODES, snapshotWarningCodes } from '../dist/evidence/snapshotWarningCodes.js';

test('snapshot diagnostics preserve reason codes and never raw Git errors or source paths', () => {
  const codes = snapshotWarningCodes([
    'unsupported-file',
    'git ls-files -z --cached --others --exclude-standard timed out after 1000ms.',
    'git status failed to start: Error: /private/TEST/source/secret ENOENT.',
    'Git workspace census unavailable or partial.',
    'Unable to read git status for task-change ledger.',
    'unsupported-file',
    '/private/TEST/unrecognized-source-error',
  ]);
  assert.deepEqual(codes, ['unsupported-file', 'git-timeout', 'git-start-failed', 'git-census-unavailable', 'git-status-unavailable', 'snapshot-warning-unknown']);
  assert.equal(JSON.stringify(codes).includes('/private'), false);
  assert.equal(JSON.stringify(codes).includes('secret'), false);
});

test('snapshot diagnostics bound input processing and emitted warning inventory', () => {
  const codes = snapshotWarningCodes(Array.from({length: 1000}, () => 'read-error'));
  assert.deepEqual(codes, ['read-error', 'snapshot-warning-cap']);
  assert.ok(codes.length <= MAX_SNAPSHOT_WARNING_CODES);
  assert.deepEqual(snapshotWarningCodes([]), []);
});
