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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { FileContentResolver } from '@agent-teams/task-change-ledger/review-content';
import { classifyTaskChangeReviewability } from '@agent-teams/task-change-ledger/reviewability';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { createClaudeToolEvidenceCapture } from '../dist/evidence/ClaudeToolEvidenceWriter.js';
import { evidenceProjectDir } from '../dist/evidence/evidenceProjectDir.js';
import { ToolEvidenceWindows } from '../dist/evidence/ToolEvidenceWindows.js';
import { digest } from '../dist/team/identity.js';
import { deliveryFingerprint, runtimeDigest } from '../dist/runtime/identity.js';
import type { ClaudeCapturePort, ClaudeCaptureRequest } from '@agent-teams/provider-implementations/claude';
import type { RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import type { TestContext } from 'node:test';

async function batch(capture: ClaudeCapturePort, request: Extract<ClaudeCaptureRequest, { phase: 'before' }>, outcome: 'succeeded' | 'failed' = 'succeeded') {
  assert.ok(capture.observeBatch);
  await capture.observeBatch({ sessionRef: request.sessionRef, inputId: request.inputId,
    operationRef: request.operationRef, boundary: 'post-tool-use-hooks', signal: request.signal,
    tools: [{ toolUseId: request.toolUseId, toolName: request.toolName, toolInput: request.toolInput, outcome }] });
}

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-task-tool-writer-')));
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
    requiredCapabilities: ['session.conversation'],
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
  const request: Extract<ClaudeCaptureRequest, { phase: 'before' }> = {
    phase: 'before',
    sessionRef: 'TEST-native',
    inputId: intent.inputId,
    operationRef: 'TEST-operation',
    toolUseId: 'TEST-tool',
    toolName: 'Write',
    toolInput: { file_path: file },
    signal: controller.signal,
  };
  const projectDir = evidenceProjectDir(join(root, 'storage'), binding.teamName);
  const windows = new ToolEvidenceWindows();
  let current = true,
    refuseFence = false;
  const make = () =>
    createClaudeToolEvidenceCapture({
      captured,
      ledgerProjectDir: projectDir,
      windows,
      readRuntime: () => ({ record, attached: true }),
      lookupTaskCause: (input) => owner.lookupTaskStartCause('human', input),
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

test('anchored Write keeps dirty before/final review content while secondary hook effects remain metadata only', async (t) => {
  const f = fixture(t);
  const request = { ...f.request, toolInput: { file_path: f.file, content: 'TEST final observed\n' } };
  await f.capture.observe(request);
  const before = JSON.parse(readFileSync(f.notices, 'utf8').trim()) as {
    preimages: { ref: { blobRef: string } }[];
  };
  assert.equal(
    readFileSync(
      join(f.projectDir, '.board-task-changes', 'blobs', before.preimages[0]!.ref.blobRef),
      'utf8'
    ),
    'TEST initially dirty\n'
  );
  writeFileSync(f.file, 'TEST final observed\n');
  f.record.inputs[0]!.phase = 'consumed';
  const after = { ...request, phase: 'after' as const, outcome: 'succeeded' as const };
  await f.capture.observe(after);
  assert.equal(existsSync(f.events), false, 'PostToolUse is provisional');
  const side = join(f.workspace, 'late-post-hook.txt');
  writeFileSync(side, 'TEST mapped hook effect\n');
  await batch(f.capture, request);
  const view = (await f.read())!;
  assert.equal(view.files[0]!.snippets[0]!.ledger!.originalFullContent, 'TEST initially dirty\n');
  assert.equal(view.files[0]!.snippets[0]!.ledger!.modifiedFullContent, 'TEST final observed\n');
  assert.equal(classifyTaskChangeReviewability(view).reviewability, 'attention_required');
  const sideView = view.files.find((row) => row.filePath === side);
  assert.ok(sideView, 'mapped hook secondary path is discovered at the batch boundary');
  assert.equal(sideView.snippets[0]!.ledger!.modifiedFullContent, null);
  assert.equal(sideView.snippets[0]!.ledger!.nativeCapture, 'unqualified');
  const resolver = new FileContentResolver({ mode: 'ledger-only' });
  const primary = view.files.find((row) => row.filePath === f.file)!;
  assert.equal(primary.snippets[0]!.ledger!.nativeCapture, 'qualified');
  assert.equal((await resolver.getFileContent('test', 'alice', f.file, primary.snippets)).modifiedFullContent, 'TEST final observed\n');
  assert.equal((await resolver.getFileContent('test', 'alice', side, sideView.snippets)).contentSource, 'unavailable');
  assert.equal(sideView.snippets[0]!.ledger!.originalFullContent, null, 'Git omission never proves an absent preimage');
  const rows = readFileSync(f.events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(rows.every((row) => row.executionSeq === 0 && row.causalBinding.provenance.reviewableComplete === false));
  const bytes = readFileSync(f.events, 'utf8');
  await f.capture.observe(after);
  await batch(f.capture, request);
  assert.equal(
    readFileSync(f.events, 'utf8'),
    bytes,
    'same native after callback never duplicates an event'
  );
});

test('failed Bash partial effects retain real dirty preimage and final bytes rather than HEAD', async (t) => {
  const f = fixture(t);
  const request = {
    ...f.request,
    toolName: 'Bash',
    toolInput: { command: 'TEST opaque command; never parsed' },
  };
  await f.capture.observe(request);
  writeFileSync(f.file, 'TEST failed partial effect\n');
  await f.capture.observe({ ...request, phase: 'after', outcome: 'failed' });
  assert.equal(existsSync(f.events), false);
  await batch(f.capture, request, 'failed');
  const view = (await f.read())!;
  assert.equal(view.files[0]!.snippets[0]!.ledger!.originalFullContent, null);
  assert.equal(view.files[0]!.snippets[0]!.ledger!.nativeCapture, 'unqualified');
  const row = JSON.parse(readFileSync(f.events, 'utf8').trim());
  assert.equal(readFileSync(join(f.projectDir, '.board-task-changes', 'blobs', row.before.blobRef), 'utf8'), 'TEST initially dirty\n');
  assert.equal(readFileSync(join(f.projectDir, '.board-task-changes', 'blobs', row.after.blobRef), 'utf8'), 'TEST failed partial effect\n');
  assert.equal((await new FileContentResolver({ mode: 'ledger-only' }).getFileContent('test', 'alice', f.file, view.files[0]!.snippets)).contentSource, 'unavailable');
  assert.equal(
    view.files[0]!.snippets[0]!.ledger!.modifiedFullContent,
    null
  );
  assert.ok(
    view.reviewDiagnostics?.some(
      (row) => row.code === 'tool_failed_after_edit' && row.reviewBlocking
    )
  );
  assert.equal(
    (JSON.parse(readFileSync(f.events, 'utf8').trim()) as { toolStatus: string }).toolStatus,
    'failed'
  );
});

test('generic initial launch and unknown input have an explicit gap without inventing a Task journal', async (t) => {
  const f = fixture(t);
  f.record.inputs = [];
  await f.capture.observe(f.request);
  assert.deepEqual(f.capture.readStatus(), { phase: 'gap', reason: 'input' });
  assert.equal(existsSync(f.projectDir), false);
});

test('shared Host window authority marks overlapping member intervals uncertain', async (t) => {
  const f = fixture(t),
    second = f.make();
  const other = { ...f.request, toolUseId: 'TEST-overlap' };
  await f.capture.observe(f.request);
  await second.observe(other);
  writeFileSync(f.file, 'TEST overlap\n');
  await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
  await second.observe({ ...other, phase: 'after', outcome: 'succeeded' });
  await batch(f.capture, f.request);
  await batch(second, other);
  assert.equal(existsSync(f.events), false, 'overlap must never duplicate one workspace interval into two tool owners');
  const rows = readFileSync(f.notices, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { message: string });
  assert.equal(rows.filter((row) => row.message.includes('overlapping-windows')).length, 2);

});

test('late aborted/sealed callbacks and abort at final write fence produce no artifact writes', async (t) => {
  for (const mode of ['abort', 'seal', 'fence'] as const) {
    const f = fixture(t);
    const pending = f.capture.observe(f.request);
    if (mode === 'abort') f.controller.abort();
    if (mode === 'seal') f.capture.seal();
    if (mode === 'fence') f.refuse();
    await pending;
    assert.equal(existsSync(f.projectDir), false, mode);
    await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
    assert.equal(existsSync(f.projectDir), false, mode);
  }
});

test('changed workspace identity and stale generation cannot append final evidence', async (t) => {
  const f = fixture(t);
  await f.capture.observe(f.request);
  const bytes = readFileSync(f.notices, 'utf8');
  renameSync(f.workspace, `${f.workspace}-original`);
  mkdirSync(f.workspace);
  writeFileSync(f.file, 'TEST replaced workspace\n');
  await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
  assert.equal(existsSync(f.events), false);
  assert.equal(readFileSync(f.notices, 'utf8'), bytes);
  f.stale();
  await f.capture.observe(f.request);
  assert.equal(readFileSync(f.notices, 'utf8'), bytes);
});

test('mismatched after input and unsupported/outside paths never create trustworthy file evidence', async (t) => {
  const f = fixture(t);
  await f.capture.observe(f.request);
  await f.capture.observe({
    ...f.request,
    phase: 'after',
    outcome: 'succeeded',
    toolInput: { file_path: f.file, content: 'TEST altered' },
  });
  assert.equal(f.capture.readStatus().reason, 'pair-mismatch');
  assert.equal(existsSync(f.events), false);
  const outside = {
    ...f.request,
    toolUseId: 'TEST-outside',
    toolInput: { file_path: join(f.root, 'not-workspace') },
  };
  await f.capture.observe(outside);
  await f.capture.observe({ ...outside, phase: 'after', outcome: 'failed' });
  assert.equal(existsSync(f.events), false);
});


test('original binding is rechecked after final snapshot awaits; custody or seal prevents publication', async (t) => {
  for (const mode of ['custody', 'seal', 'fence'] as const) {
    const f = fixture(t);
    await f.capture.observe(f.request);
    writeFileSync(f.file, 'TEST effect before authority loss\n');
    await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
    const notices = readFileSync(f.notices, 'utf8');
    const pending = batch(f.capture, f.request);
    if (mode === 'custody') f.record.custody = 'released';
    if (mode === 'seal') f.capture.seal();
    if (mode === 'fence') f.refuse();
    await pending;
    assert.equal(existsSync(f.events), false, mode);
    assert.equal(readFileSync(f.notices, 'utf8'), notices, mode);
  }
});

test('background and missing-batch callbacks gap the retained original pair without final events', async (t) => {
  for (const reason of ['background', 'missing-batch'] as const) {
    const f = fixture(t);
    await f.capture.observe(f.request);
    writeFileSync(f.file, 'TEST unqualified effect\n');
    await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
    await f.capture.observe({ ...f.request, phase: 'gap', reason });
    await batch(f.capture, f.request);
    assert.equal(existsSync(f.events), false);
    assert.match(readFileSync(f.notices, 'utf8'), new RegExp(reason));
  }
});

test('multi-tool batches never manufacture a per-tool workspace order or repeat shared effects', async (t) => {
  const f = fixture(t);
  await f.capture.observe(f.request);
  await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
  await f.capture.observeBatch!({ ...f.request, boundary: 'post-tool-use-hooks', tools: [
    { ...f.request, outcome: 'succeeded' },
    { ...f.request, toolUseId: 'TEST-foreign', outcome: 'succeeded' },
  ] });
  assert.equal(existsSync(f.events), false);
  assert.match(readFileSync(f.notices, 'utf8'), /multi-tool-batch/);
});

test('conflicting batch during pending final snapshot invalidates original settlement; foreign input cannot consume it', async (t) => {
  const f = fixture(t);
  await f.capture.observe(f.request);
  writeFileSync(f.file, 'TEST effect\n');
  await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
  await batch(f.capture, { ...f.request, inputId: 'TEST-next-input' });
  assert.equal(existsSync(f.events), false);
  const pending = batch(f.capture, f.request);
  await batch(f.capture, f.request, 'failed');
  await pending;
  assert.equal(existsSync(f.events), false);
  assert.match(readFileSync(f.notices, 'utf8'), /batch-mismatch/);
});

test('selected census includes ignored direct target; native object key reorder is not a new input', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, '.gitignore'), 'ignored.txt\nnode_modules/\n');
  const ignored = join(f.workspace, 'ignored.txt');
  writeFileSync(ignored, 'TEST ignored dirty before\n');
  mkdirSync(join(f.workspace, 'node_modules'));
  for (let index = 0; index < 90; index++) writeFileSync(join(f.workspace, 'node_modules', `file${index}`), 'TEST');
  const request = { ...f.request, toolInput: { file_path: ignored, content: 'TEST ignored final\n' } };
  await f.capture.observe(request);
  writeFileSync(ignored, 'TEST ignored final\n');
  await f.capture.observe({ ...request, phase: 'after', outcome: 'succeeded' });
  await batch(f.capture, { ...request, toolInput: { content: 'TEST ignored final\n', file_path: ignored } });
  const view = (await f.read())!;
  const changed = view.files.find((row) => row.filePath === ignored)!;
  assert.equal(changed.snippets[0]!.ledger!.originalFullContent, 'TEST ignored dirty before\n');
  assert.equal(changed.snippets[0]!.ledger!.modifiedFullContent, 'TEST ignored final\n');
});

test('nested projects, symlinks and capped selected census remain gaps rather than trustworthy attribution', async (t) => {
  for (const mode of ['nested', 'symlink', 'cap'] as const) {
    const f = fixture(t);
    if (mode === 'nested') {
      const nested = join(f.workspace, 'nested');
      mkdirSync(nested);
      writeFileSync(join(nested, '.git'), 'TEST nested repository marker');
      writeFileSync(join(nested, 'effect.txt'), 'TEST nested');
    }
    if (mode === 'symlink') symlinkSync(f.file, join(f.workspace, 'linked'));
    if (mode === 'cap') for (let index = 0; index < 81; index++) writeFileSync(join(f.workspace, `path${index}`), 'TEST');
    await f.capture.observe(f.request);
    writeFileSync(f.file, 'TEST effect with incomplete coverage\n');
    await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
    await batch(f.capture, f.request);
    assert.equal(existsSync(f.events), false, mode);
    assert.match(readFileSync(f.notices, 'utf8'), /incomplete-workspace-census/);
  }
});

test('overlap during awaited before capture emits original-owner gap notices for both windows', async (t) => {
  const f = fixture(t);
  const second = f.make();
  const other = { ...f.request, toolUseId: 'TEST-overlap-during-await' };
  const pending = f.capture.observe(f.request);
  await second.observe(other);
  await pending;
  await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
  await second.observe({ ...other, phase: 'after', outcome: 'succeeded' });
  await batch(f.capture, f.request);
  await batch(second, other);
  assert.equal(existsSync(f.events), false);
  const rows = readFileSync(f.notices, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows.filter((row) => row.message.includes('overlapping-windows')).map((row) => row.toolUseId).sort(),
    [f.request.toolUseId, other.toolUseId].sort());
});

test('explicit new direct target proves absence, while an undiscovered hook path never borrows that proof', async (t) => {
  const f = fixture(t);
  const target = join(f.workspace, 'new-target.txt');
  const request = { ...f.request, toolInput: { file_path: target } };
  await f.capture.observe(request);
  writeFileSync(target, 'TEST direct create\n');
  await f.capture.observe({ ...request, phase: 'after', outcome: 'succeeded' });
  await batch(f.capture, request);
  const row = JSON.parse(readFileSync(f.events, 'utf8').trim());
  assert.equal(row.operation, 'create');
  assert.deepEqual(row.beforeState, { exists: false });
  assert.equal(row.executionSeq, 0);
});

test('D gap uses fresh notification signal after aborting the retained provisional signal', async (t) => {
  const f = fixture(t);
  await f.capture.observe(f.request);
  await f.capture.observe({ ...f.request, phase: 'after', outcome: 'succeeded' });
  f.controller.abort();
  const gapSignal = new AbortController().signal;
  await f.capture.observe({ ...f.request, phase: 'gap', reason: 'background', signal: gapSignal });
  assert.equal(existsSync(f.events), false);
  assert.match(readFileSync(f.notices, 'utf8'), /Native capture gap: background/);
});

test('exact Edit is qualified; later anchored Write cannot launder an unqualified delta in the same file', async (t) => {
  const f = fixture(t);
  const edit = { ...f.request, toolName: 'Edit', toolInput: {
    file_path: f.file, old_string: 'initially dirty', new_string: 'authored edit',
  } };
  await f.capture.observe(edit);
  writeFileSync(f.file, 'TEST authored edit\n');
  await f.capture.observe({ ...edit, phase: 'after', outcome: 'succeeded' });
  await batch(f.capture, edit);
  let file = (await f.read())!.files.find((row) => row.filePath === f.file)!;
  const resolver = new FileContentResolver({ mode: 'ledger-only' });
  assert.equal(file.snippets[0]!.ledger!.nativeCapture, 'qualified');
  assert.equal((await resolver.getFileContent('test', 'alice', f.file, file.snippets)).originalFullContent, 'TEST initially dirty\n');
  const mismatched = { ...f.request, toolUseId: 'TEST-mismatch', toolInput: { file_path: f.file, content: 'TEST intended\n' } };
  await f.capture.observe(mismatched);
  writeFileSync(f.file, 'TEST unrelated delta\n');
  await f.capture.observe({ ...mismatched, phase: 'after', outcome: 'succeeded' });
  await batch(f.capture, mismatched);
  const last = { ...f.request, toolUseId: 'TEST-last', toolInput: { file_path: f.file, content: 'TEST final authored\n' } };
  await f.capture.observe(last);
  writeFileSync(f.file, 'TEST final authored\n');
  await f.capture.observe({ ...last, phase: 'after', outcome: 'succeeded' });
  await batch(f.capture, last);
  file = (await f.read())!.files.find((row) => row.filePath === f.file)!;
  assert.deepEqual(file.snippets.map((snippet) => snippet.ledger!.nativeCapture), ['qualified', 'unqualified', 'qualified']);
  const content = await resolver.getFileContent('test', 'alice', f.file, file.snippets);
  assert.equal(content.contentSource, 'unavailable');
  assert.equal(content.originalFullContent, null);
  assert.equal(content.modifiedFullContent, null);
});


test('exact background notification retains original terminal input observations without file authorship qualification', async t => {
  const f = fixture(t), observation = new AbortController();
  const request = { ...f.request, toolName: 'Bash', toolInput: { command: 'TEST never execute', run_in_background: true } };
  assert.ok(f.capture.observeBackground);
  await f.capture.observe(request);
  await f.capture.observe({ ...request, phase: 'after', outcome: 'succeeded' });
  const registered = { ...request, signal: observation.signal, phase: 'registered' as const,
    boundary: 'native-background-registration' as const, taskRef: 'TEST-native-background', runRef: 'TEST-native-run' };
  await f.capture.observeBackground(registered);
  f.record.inputs[0]!.phase = 'terminal'; f.record.inputs[0]!.terminal = 'succeeded'; f.controller.abort();
  writeFileSync(f.file, 'TEST eventual background observation\n');
  await f.capture.observeBackground({ ...registered, phase: 'terminal', boundary: 'native-task-notification', status: 'completed' });
  const rows = readFileSync(f.events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => row.causalBinding.inputId === request.inputId && row.toolUseId === request.toolUseId &&
    row.causalBinding.provenance.reviewableComplete === false && !row.nativeCaptureProof));
  const notices = readFileSync(f.notices, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const terminal = notices.find(row => row.captureBoundary === 'native-task-notification');
  assert.equal(terminal.nativeTaskRef, registered.taskRef);
  assert.notEqual(terminal.taskRef, registered.taskRef, 'native task identity never replaces canonical product Task identity');
  assert.equal(f.capture.readStatus().reason, 'unqualified-native-interval');
});

test('background stopped, stale, overlapping and mismatched native observations cannot publish final bytes', async t => {
  for (const mode of ['stopped', 'stale', 'overlap', 'mismatch'] as const) {
    const f = fixture(t), observation = new AbortController();
    const request = { ...f.request, toolName: 'Bash', toolInput: { command: 'TEST never execute' } };
    assert.ok(f.capture.observeBackground);
    await f.capture.observe(request); await f.capture.observe({ ...request, phase: 'after', outcome: 'succeeded' });
    const registered = { ...request, signal: observation.signal, phase: 'registered' as const,
      boundary: 'native-background-registration' as const, taskRef: 'TEST-native-background', runRef: 'TEST-native-run' };
    await f.capture.observeBackground(registered);
    if (mode === 'stale') f.stale();
    if (mode === 'overlap') await f.make().observe({ ...request, toolUseId: 'TEST-sibling' });
    writeFileSync(f.file, 'TEST unqualified late bytes\n');
    await f.capture.observeBackground({ ...registered, phase: 'terminal', boundary: 'native-task-notification',
      runRef: mode === 'mismatch' ? 'TEST-foreign-run' : registered.runRef, status: mode === 'stopped' ? 'stopped' : 'completed' });
    assert.equal(existsSync(f.events), false, mode);
    assert.equal(f.capture.readStatus().phase, 'gap', mode);
    f.capture.seal();
  }
});
