import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyExactCodexUpdatePatch } from '../dist/evidence/exactCodexUpdatePatch.js';
const before = 'TEST clean anchor\nTEST dirty preimage\nTEST tail\n';
const diff =
  '@@ -1,3 +1,3 @@\n TEST clean anchor\n-TEST dirty preimage\n+TEST native foreground patched\n TEST tail\n';
test('actual native v2 payload replays exactly over dirty preimage and reverses internally', () => {
  assert.equal(
    applyExactCodexUpdatePatch(before, diff),
    before.replace('dirty preimage', 'native foreground patched')
  );
});
for (const [name, original, patch] of [
  ['wrong position', before, diff.replace('-1,3 +1,3', '-2,3 +2,3')],
  ['wrong context', before.replace('dirty preimage', 'other dirty bytes'), diff],
  ['wrong counts', before, diff.replace('-1,3 +1,3', '-1,2 +1,3')],
  ['CRLF', before.replaceAll('\n', '\r\n'), diff],
  ['no final newline', before.slice(0, -1), diff],
  ['binary', 'x\0\n', diff],
  ['no-newline marker', before, diff + '\\ No newline at end of file\n'],
  ['empty', before, ''],
] as const)
  test(`strict Codex patch refuses ${name} rather than fuzzy or synthetic reconstruction`, () => {
    assert.throws(() => applyExactCodexUpdatePatch(original, patch));
  });
