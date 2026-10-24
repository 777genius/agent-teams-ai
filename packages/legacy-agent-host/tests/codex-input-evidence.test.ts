import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { FileContentResolver } from '@agent-teams/task-change-ledger/review-content';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { createCodexInputEvidenceCapture } from '../dist/evidence/CodexInputEvidenceWriter.js';
import { evidenceProjectDir } from '../dist/evidence/evidenceProjectDir.js';
import { ToolEvidenceWindows } from '../dist/evidence/ToolEvidenceWindows.js';
import { digest } from '../dist/team/identity.js';
import { deliveryFingerprint, runtimeDigest } from '../dist/runtime/identity.js';
import type {
  CodexCaptureRequest,
  CodexAfterRequest,
} from '../dist/evidence/codexCaptureContracts.js';
import { ReviewApplier } from '@agent-teams/task-change-ledger/review-apply';
import type { RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-codex-input-evidence-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const file = join(workspace, 'dirty.txt');
  writeFileSync(file, 'TEST base\n');
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: workspace,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  git(['init', '-q']);
  git(['add', 'dirty.txt']);
  writeFileSync(file, 'TEST initially dirty\n');
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-writer' };
  const owner = createFilesystemTeamOwner({
    root: join(root, 'storage'),
    binding,
    members: ['lead', 'worker'].map((name) => ({
      name,
      memberId: `${name}-id`,
      role: name === 'lead' ? 'lead' : 'member',
      delivery: { ...binding, runId: 'TEST-run', memberId: `${name}-id`, generation: '1' },
    })),
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
      {
        principalId: 'worker-principal',
        memberName: 'worker',
        permissions: ['read', 'task.write', 'message.write'],
      },
    ],
  });
  const human = owner.connect('human');
  const created = human.execute({
    commandId: 'TEST-create',
    operation: 'task.create',
    payload: { subject: 'TEST task', owner: 'worker' },
  });
  human.execute({
    commandId: 'TEST-start',
    operation: 'task.start',
    payload: { taskId: created.effects.taskId, notification: 'user' },
  });
  const intent = human.pendingDeliveries().find((row) => row.commandId === 'TEST-start')!;
  assert.ok(intent, 'actual canonical task.start must persist the notified input');
  const config = {
    tenantId: 'TEST-backend',
    projectId: 'TEST-project',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-config',
    requiredCapabilities: ['text', 'tools'],
  };
  const info = statSync(workspace);
  const captured = {
    binding: intent.binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-incarnation',
    config,
    workspace: { path: workspace, identity: digest({ dev: info.dev, ino: info.ino }) },
  };
  const record: RuntimeSessionRecord = {
    schemaVersion: 1,
    binding: intent.binding,
    profileId: captured.profileId,
    config,
    hostIncarnation: captured.hostIncarnation,
    openFingerprint: runtimeDigest({ profileId: captured.profileId, config }),
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    nativeReady: true,
    sessionRef: 'TEST-native',
    inputs: [
      {
        intent,
        fingerprint: deliveryFingerprint(intent),
        operationRef: 'TEST-operation',
        phase: 'claimed',
      },
    ],
    interactions: [],
  };
  const controller = new AbortController();
  const request: Extract<CodexCaptureRequest, { phase: 'before' }> = {
    phase: 'before',
    sessionRef: 'TEST-native',
    inputId: intent.inputId,
    operationRef: 'TEST-operation',
    windowRef: 'TEST-window',
    threadId: 'TEST-thread',
    signal: controller.signal,
  };
  const projectDir = evidenceProjectDir(join(root, 'storage'), binding.teamName);
  const windows = new ToolEvidenceWindows();
  let current = true,
    refuseFence = false;
  const make = () =>
    createCodexInputEvidenceCapture({
      captured,
      ledgerProjectDir: projectDir,
      windows,
      readRuntime: () => ({ record, attached: true }),
      lookupTaskCause: (input) => owner.lookupTaskStartCause('human', input),
      lookupInputCause: (input) => owner.lookupToolInputCause('human', input),
      assertCurrent() {
        if (!current) throw new Error('TEST stale');
      },
      withWriteFence(action) {
        if (refuseFence) {
          controller.abort();
        }
        return action();
      },
    });
  const capture = make();
  const read = () =>
    new TaskChangeLedgerReader().readTaskChanges({
      teamName: binding.teamName,
      taskId: created.effects.taskId,
      projectDir,
      projectPath: workspace,
      includeDetails: true,
    });
  const notices = join(
    projectDir,
    '.board-task-changes',
    'notices',
    `${encodeURIComponent(created.effects.taskId)}.jsonl`
  );
  const events = join(
    projectDir,
    '.board-task-changes',
    'events',
    `${encodeURIComponent(created.effects.taskId)}.jsonl`
  );
  return {
    root,
    owner,
    human,
    taskId: created.effects.taskId,
    captured,
    workspace,
    file,
    record,
    request,
    capture,
    make,
    read,
    projectDir,
    notices,
    events,
    controller,
    stale: () => {
      current = false;
    },
    refuse: () => {
      refuseFence = true;
    },
  };
}

const patch = (old: string, next: string) => `@@ -1 +1 @@\n-${old}\n+${next}\n`;
function terminal(
  f: ReturnType<typeof fixture>,
  diffs = [patch('TEST initially dirty', 'TEST final observed')]
): CodexAfterRequest {
  return {
    ...f.request,
    phase: 'after',
    turnId: 'TEST-turn',
    beforeObserved: true,
    outcome: 'completed',
    items: diffs.flatMap((diff, index) => {
      const changes = [{ path: f.file, kind: { type: 'update', move_path: null }, diff }];
      return [
        {
          itemId: `TEST-native-${index}`,
          phase: 'started' as const,
          status: 'inProgress',
          changes,
        },
        {
          itemId: `TEST-native-${index}`,
          phase: 'completed' as const,
          status: 'completed',
          changes,
        },
      ];
    }),
  };
}
test('original claimed input captures dirty bytes and actual Codex update proof through cold Task/content/review reads', async (t) => {
  const f = fixture(t);
  assert.equal(f.record.inputs[0]!.phase, 'claimed');
  await f.capture.observe(f.request);
  assert.equal(f.capture.readStatus().baseline, 'ready');
  const notice = JSON.parse(readFileSync(f.notices, 'utf8').trim()) as {
    toolUseId?: string;
    captureWindowRef: string;
  };
  assert.equal(notice.toolUseId, undefined, 'input baseline must not invent a native item ID');
  assert.equal(notice.captureWindowRef, f.request.windowRef);
  writeFileSync(f.file, 'TEST final observed\n');
  await f.capture.observe(terminal(f));
  const row = JSON.parse(readFileSync(f.events, 'utf8').trim()) as {
    taskId: string;
    toolUseId: string;
    nativeCaptureProof: { kind: string; itemIds: string[] };
  };
  assert.equal(row.taskId, f.taskId);
  assert.equal(row.toolUseId, 'TEST-native-0');
  assert.equal(row.nativeCaptureProof.kind, 'codex-update-patch-v1');
  assert.deepEqual(row.nativeCaptureProof.itemIds, ['TEST-native-0']);
  f.capture.seal();
  const changes = await f.read();
  assert.ok(changes);
  const content = await new FileContentResolver({ mode: 'ledger-only' }).getFileContent(
    'test-writer',
    'worker',
    f.file,
    changes.files[0]!.snippets
  );
  assert.equal(content.originalFullContent, 'TEST initially dirty\n');
  assert.equal(content.modifiedFullContent, 'TEST final observed\n');
  assert.equal(changes.files[0]!.snippets[0]!.ledger!.nativeCapture, 'qualified');
  const result = await new ReviewApplier().applyReviewDecisions(
    {
      teamName: 'test-writer',
      taskId: f.taskId,
      decisions: [{ filePath: f.file, fileDecision: 'rejected', hunkDecisions: {} }],
    },
    new Map([[f.file, content]])
  );
  assert.equal(result.applied, 1);
  assert.equal(
    readFileSync(f.file, 'utf8'),
    'TEST initially dirty\n',
    'review must restore captured dirty bytes, never Git/index'
  );
});
test('ordered same-path native patch chain records one actual endpoint event with all original item IDs', async (t) => {
  const f = fixture(t);
  await f.capture.observe(f.request);
  writeFileSync(f.file, 'TEST final observed\n');
  await f.capture.observe(
    terminal(f, [
      patch('TEST initially dirty', 'TEST middle'),
      patch('TEST middle', 'TEST final observed'),
    ])
  );
  const row = JSON.parse(readFileSync(f.events, 'utf8').trim()) as {
    nativeCaptureProof: { itemIds: string[] };
    toolUseId: string;
  };
  assert.deepEqual(row.nativeCaptureProof.itemIds, ['TEST-native-0', 'TEST-native-1']);
  assert.equal(row.toolUseId, 'TEST-native-1');
  assert.equal(readFileSync(f.events, 'utf8').trim().split('\n').length, 1);
});
for (const mode of [
  'missed',
  'failed',
  'unknown',
  'thread',
  'patch',
  'bytes',
  'unsupported',
  'duplicate',
  'overlap',
  'extra-file',
  'revoke',
  'stale',
  'binary',
] as const) {
  test(`Codex ${mode} observation remains GAP with no qualified event or disk rewrite`, async (t) => {
    const f = fixture(t);
    await f.capture.observe(f.request);
    let after = terminal(f);
    writeFileSync(f.file, 'TEST final observed\n');
    if (mode === 'missed') after = { ...after, beforeObserved: false };
    if (mode === 'failed') after = { ...after, outcome: 'failed' };
    if (mode === 'unknown') {
      f.record.inputs[0]!.phase = 'unknown';
    }
    if (mode === 'thread') after = { ...after, threadId: 'TEST-foreign-thread' };
    if (mode === 'patch')
      after = terminal(f, [patch('TEST wrong preimage', 'TEST final observed')]);
    if (mode === 'bytes') writeFileSync(f.file, 'TEST independent newer bytes\n');
    if (mode === 'unsupported')
      after = {
        ...after,
        items: after.items.map((item) => ({
          ...item,
          changes: [
            {
              path: f.file,
              kind: { type: 'delete' },
              diff: patch('TEST initially dirty', 'TEST final observed'),
            },
          ],
        })),
      };
    if (mode === 'duplicate') after = { ...after, items: [...after.items, ...after.items] };
    if (mode === 'overlap') await f.make().observe({ ...f.request, windowRef: 'TEST-overlap' });
    if (mode === 'extra-file')
      writeFileSync(join(f.workspace, 'other.txt'), 'TEST unexplained change\n');
    if (mode === 'revoke') f.human.revoke('human');
    if (mode === 'stale') f.stale();
    if (mode === 'binary') writeFileSync(f.file, Buffer.from([0, 255]));
    const originalDisk = readFileSync(f.file);
    await f.capture.observe(after);
    assert.equal(existsSync(f.events), false);
    assert.deepEqual(readFileSync(f.file), originalDisk);
    assert.equal(f.capture.readStatus().phase, 'gap');
  });
}
test('aborted before baseline cannot publish late preimages or resurrect from a later terminal callback', async (t) => {
  const f = fixture(t);
  const pending = f.capture.observe(f.request);
  f.controller.abort();
  await pending;
  writeFileSync(f.file, 'TEST final observed\n');
  await f.capture.observe({ ...terminal(f), signal: new AbortController().signal });
  assert.equal(existsSync(f.events), false);
  assert.equal(f.capture.readStatus().baseline, 'missed');
});
test('wrong original input reference cannot bind to another admitted or latest Task', async (t) => {
  const f = fixture(t);
  const other = f.human.execute({
    commandId: 'TEST-other-task',
    operation: 'task.create',
    payload: { subject: 'TEST unrelated', owner: 'worker' },
  });
  f.human.execute({
    commandId: 'TEST-other-start',
    operation: 'task.start',
    payload: { taskId: other.effects.taskId, notification: 'user' },
  });
  await f.capture.observe({ ...f.request, operationRef: 'TEST-not-original' });
  writeFileSync(f.file, 'TEST final observed\n');
  await f.capture.observe({ ...terminal(f), operationRef: 'TEST-not-original' });
  assert.equal(existsSync(f.events), false);
  assert.equal(f.capture.readStatus().phase, 'gap');
});
test('snapshot census cap refuses baseline before native changes', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 81; i++) writeFileSync(join(f.workspace, `extra-${i}.txt`), 'TEST cap\n');
  await f.capture.observe(f.request);
  assert.equal(f.capture.readStatus().phase, 'gap');
  assert.equal(f.capture.readStatus().reason, 'incomplete-workspace-census');
  const notice = JSON.parse(readFileSync(f.notices, 'utf8').trim().split('\n').at(-1)!);
  assert.ok(notice.captureWarningCodes.includes('git-path-cap'));
  assert.ok(notice.captureWarningCodes.every((code: string) => code === 'git-path-cap' || code === 'path-cap'));
  assert.ok(notice.captureWarningCodes.length <= 16);
  assert.match(notice.message, /Snapshot warning codes: git-path-cap/);
  assert.equal(f.capture.readStatus().baseline, 'missed');
  assert.equal(existsSync(f.events), false);
});
test('captured workspace inode replacement cannot capture the replacement directory', async (t) => {
  const f = fixture(t);
  renameSync(f.workspace, join(f.root, 'original-workspace'));
  mkdirSync(f.workspace);
  writeFileSync(f.file, 'TEST replacement workspace bytes\n');
  await f.capture.observe(f.request);
  await f.capture.observe(terminal(f));
  assert.equal(existsSync(f.events), false);
  assert.equal(readFileSync(f.file, 'utf8'), 'TEST replacement workspace bytes\n');
  assert.equal(f.capture.readStatus().phase, 'gap');
});
test('already-aborted original before callback records a missed GAP without artifacts', async (t) => {
  const f = fixture(t);
  f.controller.abort();
  await f.capture.observe(f.request);
  assert.deepEqual(f.capture.readStatus(), { phase: 'gap', baseline: 'missed', reason: 'aborted' });
  assert.equal(existsSync(f.notices), false);
  assert.equal(existsSync(f.events), false);
});

test('unsupported baseline preserves exact bounded census warning without qualifying an effect', async t => {
 const f=fixture(t);writeFileSync(f.file,Buffer.alloc(1024*1024+1,65));
 await f.capture.observe(f.request);
 assert.equal(f.capture.readStatus().reason,'incomplete-workspace-census');
 const notice=JSON.parse(readFileSync(f.notices,'utf8').trim().split('\n').at(-1)!);
 assert.deepEqual(notice.captureWarningCodes,['unsupported-file']);
 assert.match(notice.message,/Snapshot warning codes: unsupported-file/);
 assert.equal(existsSync(f.events),false);
 assert.equal(notice.captureWarningCodes.length<=16,true);
});
