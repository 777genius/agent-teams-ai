import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { qualifyOpenCodeV2FileChange } from '../dist/evidence/qualifyOpenCodeV2FileChange.js';
import { snapshotWorkspace } from '../dist/evidence/WorkspaceSnapshot.js';
import { digest } from '../dist/team/identity.js';
import type { FileImage } from '../dist/evidence/captureContracts.js';
import type { OpenCodeV2AfterRequest } from '../dist/evidence/opencodeCaptureContracts.js';

/** Shape from actual 2.1.4 native edit capture; controlled checks are not native execution evidence. */
function fixture() {
  const workspace = resolve('/TEST-v2-capture/workspace'), file = resolve(workspace, 'dirty.txt');
  const before = 'TEST clean anchor\nTEST existing dirty\nTEST unchanged tail\n';
  const after = 'TEST clean anchor\nTEST native authored\nTEST unchanged tail\n';
  const patch = 'Index: dirty.txt\n===================================================================\n--- dirty.txt\n+++ dirty.txt\n@@ -1,3 +1,3 @@\n TEST clean anchor\n-TEST existing dirty\n+TEST native authored\n TEST unchanged tail\n';
  const image = (text: string) => ({ exists: true, content: Buffer.from(text), sha256: createHash('sha256').update(text).digest('hex') });
  const snapshot = (text: string) => ({ complete: true, warnings: [], files: new Map([[file, image(text)]]) });
  const request: OpenCodeV2AfterRequest = {
    dialect: 'v2', phase: 'after', sessionRef: 'TEST-runtime', windowRef: 'TEST-window',
    inputId: 'TEST-input', operationRef: 'TEST-operation', nativeSessionId: 'ses_TESTnativeSPI',
    nativeInputId: 'msg_TESTnativeInput', beforeObserved: true, outcome: 'succeeded', signal: new AbortController().signal,
    items: [{ dialect: 'v2', protocolRevision: '2.1.4', messageId: 'msg_TESTassistant', callId: 'call_TEST_edit',
      tool: 'edit', status: 'completed', providerExecuted: false,
      input: { path: file, oldString: 'TEST existing dirty', newString: 'TEST native authored' },
      metadata: { files: [{ file: 'dirty.txt', patch, status: 'modified', additions: 1, deletions: 1 }], truncated: false },
      calledEvent: { id: 'evt_TEST_called', seq: 37 },
      completedEvent: { id: 'evt_TEST_success', seq: 39, type: 'session.tool.success' },
    }],
  };
  return { request, workspace, file, before: snapshot(before), after: snapshot(after), image };
}
test('native V2 relative file metadata and original event anchors qualify exact dirty bytes', () => {
  const f = fixture(), result = qualifyOpenCodeV2FileChange(f.request, f.workspace, f.before, f.after);
  if (result.kind === 'gap') assert.fail(result.reason);
  assert.equal(result.file, f.file); assert.equal(result.proof.kind, 'opencode-update-patch-v2');
  assert.deepEqual(result.proof.tools, [{ messageId: 'msg_TESTassistant', callId: 'call_TEST_edit',
    calledEventId: 'evt_TEST_called', calledSeq: 37, completedEventId: 'evt_TEST_success', completedSeq: 39 }]);
  assert.equal(result.proof.beforeSha256, f.before.files.get(f.file)!.sha256);
  assert.equal(result.proof.afterSha256, f.after.files.get(f.file)!.sha256);
});
test('V2 reads require a real selected file image at both original window boundaries', () => {
  const f = fixture();
  const read: OpenCodeV2AfterRequest['items'][number] = {
    ...f.request.items[0]!, tool: 'read', callId: 'call_TEST_read', input: { path: f.file }, metadata: {},
    calledEvent: { id: 'evt_TEST_read_called', seq: 1 },
    completedEvent: { id: 'evt_TEST_read_success', seq: 2, type: 'session.tool.success' },
  };
  const request = { ...f.request, items: [read, ...f.request.items] };
  assert.equal(qualifyOpenCodeV2FileChange(request, f.workspace, f.before, f.after).kind, 'qualified');
  for (const badImage of [undefined, { exists: false }, { exists: true, reason: 'symlink' },
    { exists: true, reason: 'outside-workspace' }] satisfies (FileImage | undefined)[]) {
    for (const boundary of ['before', 'after'] as const) {
      const files = new Map<string, FileImage>(f[boundary].files);
      if (badImage) files.set(f.file, badImage); else files.delete(f.file);
      const changed = { ...f[boundary], files };
      assert.deepEqual(qualifyOpenCodeV2FileChange(request, f.workspace,
        boundary === 'before' ? changed : f.before, boundary === 'after' ? changed : f.after),
      { kind: 'gap', reason: 'unqualified-v2-native-read-path' });
    }
  }
});
test('an ignored workspace symlink to an external read cannot qualify a genuine local edit snapshot', async t => {
  const f = fixture(), root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-read-path-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), outside = join(root, 'outside');
  mkdirSync(workspace); mkdirSync(outside);
  const file = join(workspace, 'dirty.txt'), external = join(outside, 'private.txt');
  writeFileSync(file, f.before.files.get(f.file)!.content);
  writeFileSync(external, 'TEST external content');
  writeFileSync(join(workspace, '.gitignore'), 'ignored\n');
  symlinkSync(outside, join(workspace, 'ignored'), process.platform === 'win32' ? 'junction' : 'dir');
  const readPath = join(workspace, 'ignored', 'private.txt');
  assert.equal(realpathSync(readPath), external);
  for (const args of [['init', '-q'], ['add', 'dirty.txt', '.gitignore']]) {
    execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: workspace, stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'TEST-absent-git-config'), GIT_CONFIG_NOSYSTEM: '1' },
    });
  }
  const info = statSync(workspace);
  const options = { workspace: { path: workspace, identity: digest({ dev: info.dev, ino: info.ino }) },
    toolName: 'opencode.fileChange', input: null, guard() {} };
  const before = await snapshotWorkspace(options);
  writeFileSync(file, f.after.files.get(f.file)!.content);
  const after = await snapshotWorkspace({ ...options, prior: before });
  assert.equal(before.complete, true); assert.equal(after.complete, true);
  assert.equal(before.files.has(readPath), false);
  const edit = { ...f.request.items[0]!, input: { path: file,
    oldString: 'TEST existing dirty', newString: 'TEST native authored' } };
  const read: OpenCodeV2AfterRequest['items'][number] = { ...edit,
    tool: 'read', callId: 'call_TEST_external', input: { path: readPath }, metadata: {},
    calledEvent: { id: 'evt_TEST_read_called', seq: 1 },
    completedEvent: { id: 'evt_TEST_read_success', seq: 2, type: 'session.tool.success' },
  };
  assert.equal(qualifyOpenCodeV2FileChange({ ...f.request, items: [edit] }, workspace, before, after).kind, 'qualified');
  assert.deepEqual(qualifyOpenCodeV2FileChange({ ...f.request, items: [read, edit] }, workspace, before, after),
    { kind: 'gap', reason: 'unqualified-v2-native-read-path' });
});
test('V2 proof refuses foreign dialect, hosted execution, truncation and fabricated lineage', () => {
  const mutations: ((item: Record<string, unknown>) => void)[] = [
    item => { delete item.dialect; }, item => { item.protocolRevision = '2.0.21'; },
    item => { item.providerExecuted = true; }, item => { item.partId = 'prt_fabricated'; },
    item => { item.status = 'error'; }, item => { item.messageId = 'msg_TESTnativeInput'; },
    item => { (item.metadata as Record<string, unknown>).truncated = true; },
    item => { delete (item.metadata as Record<string, unknown>).truncated; },
    item => { item.completedEvent = { id: 'evt_TEST_called', seq: 39, type: 'session.tool.success' }; },
    item => { item.completedEvent = { id: 'evt_TEST_success', seq: 37, type: 'session.tool.success' }; },
    item => { item.completedEvent = { id: 'evt_TEST_success', seq: 39, type: 'session.tool.failed' }; },
    item => { (item.input as Record<string, unknown>).path = resolve('/TEST-foreign/dirty.txt'); },
    item => { (item.input as Record<string, unknown>).oldString = 'TEST typographic fuzzy match'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(), item = JSON.parse(JSON.stringify(f.request.items[0])) as Record<string, unknown>;
    mutate(item);
    const request = { ...f.request, items: [item] } as unknown as OpenCodeV2AfterRequest;
    assert.equal(qualifyOpenCodeV2FileChange(request, f.workspace, f.before, f.after).kind, 'gap');
  }
});
test('V2 byte proof refuses concurrent effects, an incomplete snapshot and unexplained final bytes', () => {
  const f = fixture(), original = f.request.items[0]!;
  const overlap = { ...original, callId: 'call_TEST_other',
    calledEvent: { id: 'evt_TEST_other_called', seq: 38 },
    completedEvent: { id: 'evt_TEST_other_success', seq: 40, type: 'session.tool.success' as const } };
  assert.equal(qualifyOpenCodeV2FileChange({ ...f.request, items: [original, overlap] }, f.workspace, f.before, f.after).kind, 'gap');
  assert.equal(qualifyOpenCodeV2FileChange(f.request, f.workspace, { ...f.before, complete: false }, f.after).kind, 'gap');
  f.after.files.set(resolve(f.workspace, 'unrelated.txt'), f.image('unobserved effect\n'));
  assert.equal(qualifyOpenCodeV2FileChange(f.request, f.workspace, f.before, f.after).kind, 'gap');
  f.after.files.delete(resolve(f.workspace, 'unrelated.txt'));
  f.after.files.set(f.file, f.image('TEST clean anchor\nTEST native authored\nTEST unrelated suffix\n'));
  assert.equal(qualifyOpenCodeV2FileChange(f.request, f.workspace, f.before, f.after).kind, 'gap');
});
