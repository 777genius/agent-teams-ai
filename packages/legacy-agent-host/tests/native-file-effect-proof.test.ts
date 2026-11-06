import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qualifyNativeFileEffect } from '../dist/evidence/qualifyNativeFileEffect.js';
const image = (text: string) => ({ exists: true, content: Buffer.from(text) });
const base = { workspace: '/TEST-workspace', file: '/TEST-workspace/file.txt' };
test('native anchors accept only exact UTF-8 direct-path Edit transformations and Write contents', () => {
  const edit = (old: string, next: string, before: string, after: string, replace_all?: boolean) =>
    qualifyNativeFileEffect({ ...base, toolName: 'Edit', toolInput: { file_path: base.file, old_string: old, new_string: next, ...(replace_all === undefined ? {} : { replace_all }) }, before: image(before), after: image(after) });
  assert.equal(edit('old', 'new', 'dirty old\n', 'dirty new\n')?.kind, 'edit-input-v1');
  assert.equal(edit('old', 'new', 'old old', 'new new'), undefined, 'ambiguous single edit');
  assert.equal(edit('old', 'new', 'old old', 'new new', true)?.kind, 'edit-input-v1');
  assert.equal(edit('', 'new', 'old', 'new'), undefined);
  assert.equal(edit('old', 'new', 'dirty old', 'external new'), undefined, 'unanchored extra delta');
  assert.equal(edit('old', 'new', 'old', 'new\nhook'), undefined, 'unproven post-hook transformation');
  assert.equal(edit('old', '\ud800', 'old', '\ufffd'), undefined, 'lossy UTF-8 input');
  const write = (content: string, after: string, file_path = base.file) => qualifyNativeFileEffect({
    ...base, toolName: 'Write', toolInput: { file_path, content }, before: { exists: false }, after: image(after),
  });
  assert.equal(write('', '')?.kind, 'write-input-v1');
  assert.equal(write('expected', 'different'), undefined);
  assert.equal(write('expected', 'expected', '/TEST-workspace/secondary.txt'), undefined);
  assert.equal(write('expected', 'expected')?.beforeSha256, null, 'explicit absent preimage');
  assert.equal(qualifyNativeFileEffect({ ...base, toolName: 'Bash', toolInput: { command: 'opaque' }, before: image('old'), after: image('new') }), undefined);
});
