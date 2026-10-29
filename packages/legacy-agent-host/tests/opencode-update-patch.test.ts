import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { qualifyOpenCodeFileChange } from '../dist/evidence/qualifyOpenCodeFileChange.js';
import type { OpenCodeAfterRequest } from '../dist/evidence/opencodeCaptureContracts.js';

/** Synthetic V1 payload conformance only, not a native execution or capture proof.
 * The historical probe's tracked manifest remains separate; its local raw files
 * are not shipped in the repository and must not be required by this unit suite.
 */
function syntheticFixture() {
  const file = resolve('/TEST-synthetic-opencode/dirty.txt');
  const before = Buffer.from('TEST initial dirty marker\nTEST old value\n');
  const after = Buffer.from('TEST initial dirty marker\nTEST changed value\n');
  const patch = [
    `Index: ${file}`,
    '===================================================================',
    `--- ${file}`,
    `+++ ${file}`,
    '@@ -1,2 +1,2 @@',
    ' TEST initial dirty marker',
    '-TEST old value',
    '+TEST changed value',
    '',
  ].join('\n');
  const image = (content: Buffer) => ({
    exists: true,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
  const snapshot = (content: Buffer) => ({
    complete: true,
    warnings: [],
    files: new Map([[file, image(content)]]),
  });
  const request: OpenCodeAfterRequest = {
    sessionRef: 'TEST-synthetic-session',
    inputId: 'TEST-synthetic-input',
    operationRef: 'TEST-synthetic-operation',
    windowRef: 'TEST-synthetic-window',
    nativeSessionId: 'ses_TESTsynthetic',
    nativeInputId: 'msg_TESTsyntheticInput',
    phase: 'after',
    beforeObserved: true,
    outcome: 'succeeded',
    signal: new AbortController().signal,
    items: [{
      messageId: 'msg_TESTsyntheticAssistant',
      partId: 'prt_TESTsyntheticEdit',
      callId: 'TEST_synthetic_edit_once',
      tool: 'edit',
      status: 'completed',
      input: { filePath: file, oldString: 'TEST old value', newString: 'TEST changed value' },
      metadata: {
        truncated: false,
        diff: patch,
        filediff: { file, patch, additions: 1, deletions: 1 },
      },
      startedAt: 100,
      completedAt: 200,
    }],
  };
  return { request, file, workspace: dirname(file), before: snapshot(before), after: snapshot(after) };
}

test('synthetic V1 edit payload applies exactly over its dirty preimage', () => {
  const f = syntheticFixture();
  const result = qualifyOpenCodeFileChange(f.request, f.workspace, f.before, f.after);
  if (result.kind === 'gap') assert.fail(result.reason);
  assert.equal(result.lastCallId, 'TEST_synthetic_edit_once');
  assert.deepEqual(result.proof.tools, [{
    messageId: f.request.items[0]!.messageId,
    partId: f.request.items[0]!.partId,
    callId: 'TEST_synthetic_edit_once',
  }]);
  assert.equal(result.proof.beforeSha256, f.before.files.get(f.file)!.sha256);
  assert.equal(result.proof.afterSha256, f.after.files.get(f.file)!.sha256);
});

test('synthetic V1 patch cannot authorize externally appended final bytes', () => {
  const f = syntheticFixture(), image = f.after.files.get(f.file)!;
  const content = Buffer.concat([image.content, Buffer.from('TEST external suffix\n')]);
  f.after.files.set(f.file, {
    ...image,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
  assert.deepEqual(qualifyOpenCodeFileChange(f.request, f.workspace, f.before, f.after), {
    kind: 'gap',
    reason: 'final-byte-mismatch',
  });
});
