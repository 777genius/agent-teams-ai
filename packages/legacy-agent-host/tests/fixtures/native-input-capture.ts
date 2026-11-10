import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { FileContentResolver } from '@agent-teams/task-change-ledger/review-content';
import { ReviewApplier } from '@agent-teams/task-change-ledger/review-apply';
import { record } from './native-claude-team/model.ts';
import { fileHash, tick, treeHash, startHost } from './native-host.ts';
import { FileRuntimeStore } from '../../dist/adapters/runtime/FileRuntimeStore.js';
import { evidenceProjectDir } from '../../dist/evidence/evidenceProjectDir.js';
import { deliveryFingerprint, normalizeBinding } from '../../dist/runtime/identity.js';
import { effectId } from '../../dist/team/identity.js';
import type { TeamHostProfile } from '../../dist/composition/TeamHost.js';
import type { RuntimeMemberProfile } from '../../dist/composition/runtimeProfile.js';
import type { RuntimeInput, RuntimeSessionRecord } from '../../dist/runtime/contracts.js';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const jsonLines = (bytes: string) =>
  bytes
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => record(JSON.parse(line) as unknown));
const requireId = (value: unknown): string => {
  assert.equal(typeof value, 'string');
  assert.ok(value);
  return value as string;
};

export interface NativeCaptureFixture {
  provider: 'codex' | 'opencode';
  failedShell?: boolean;
  memberName: 'bob' | 'carol';
  goFlag: string;
  binaryEnv: string;
  binarySha256: string;
  turn: string;
  assignmentTurn: string;
  before: string;
  after: string;
  steps: number;
  taskStatus: 'completed' | 'in_progress';
  sources: string[];
  startModel(options: {
    root: string;
    workspace: string;
    taskId(): string;
    phase(): 'assignment' | 'task-start';
  }): Promise<{
    url: string;
    observations: { turn: string; step: number; contextEffective: boolean }[];
    failures: string[];
    close(): Promise<void>;
  }>;
  memberProfile(options: {
    root: string;
    workspace: string;
    node: string;
    modelUrl: string;
    native: { path: string; sha256: string };
    teamId: string;
    memberId: string;
    principalId: string;
    sessionId: string;
    environment: Record<string, string>;
  }): Promise<RuntimeMemberProfile>;
  assertNativeEvent(event: Record<string, unknown>): void;
}

/** Shared actual Host/Task/dirty-workspace/cold-review oracle; each provider owns its native configuration and anchors. */
export async function runNativeInputCapture(
  t: TestContext,
  selected: NativeCaptureFixture
): Promise<void> {
  const {
    provider,
    memberName: member,
    turn: CAPTURE_TURN,
    assignmentTurn: CAPTURE_ASSIGNMENT,
    before: CAPTURE_BEFORE,
    after: CAPTURE_AFTER,
  } = selected;
  assert.equal(process.env[selected.goFlag], '1', 'separate Root GO required; one issuance only');
  const repo = resolve(import.meta.dirname, '../../../..'),
    pkg = join(repo, 'packages/legacy-agent-host');
  const node = await realpath(
    join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
  );
  assert.equal(await realpath(process.execPath), node);
  const gitPath = '/Library/Developer/CommandLineTools/usr/bin/git';
  assert.equal(await realpath(gitPath), gitPath);
  const gitPin = { path: gitPath, sha256: await fileHash(gitPath) };
  assert.equal(gitPin.sha256, '4c5ca299b5311572b4f948d11efd7c66dcadf30950fbf260688ee32f4a63f6a4');
  const observerPath = process.env.LEGACY_NATIVE_FETCH_OBSERVER_PATH;
  const observerSha256 = process.env.LEGACY_NATIVE_FETCH_OBSERVER_SHA256;
  let diagnosticObserver: { path: string; sha256: string } | undefined;
  if (observerPath !== undefined || observerSha256 !== undefined) {
    assert.equal(provider, 'opencode', 'Root-selected diagnostic preload is OpenCode-only');
    assert.ok(observerPath);
    assert.match(observerSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(await realpath(observerPath), observerPath);
    assert.equal(await fileHash(observerPath), observerSha256);
    diagnosticObserver = { path: observerPath, sha256: observerSha256! };
  }
  const binary = process.env[selected.binaryEnv];
  assert.ok(binary);
  const native = { path: await realpath(binary), sha256: await fileHash(binary) };
  assert.equal(native.sha256, selected.binarySha256);
  const artifact = process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT;
  assert.ok(artifact);
  const entry = join(pkg, 'dist/cli.js');
  const artifacts = {
    git: gitPin,
    ...(diagnosticObserver ? { diagnosticObserver } : {}),
    node: { path: node, sha256: await fileHash(node) },
    native,
    provider: {
      path: await realpath(resolve(repo, artifact)),
      sha256: await fileHash(resolve(repo, artifact)),
    },
    fixtureSources: Object.fromEntries(
      await Promise.all(
        [
          ...selected.sources,
          'tests/fixtures/native-input-capture.ts',
          'tests/fixtures/native-host.ts',
          'tests/fixtures/native-claude-team/model.ts',
          'tests/fixtures/native-peers.ts',
        ].map(async (relative) => [relative, await fileHash(join(pkg, relative))] as const)
      )
    ),
    host: {
      entry,
      entrySha256: await fileHash(entry),
      sourceSha256: await treeHash(join(pkg, 'src'), '.ts'),
      distSha256: await treeHash(join(pkg, 'dist'), '.js'),
    },
  };
  for (const [actual, expected] of [
    [artifacts.provider.sha256, process.env.LEGACY_NATIVE_PROVIDER_SHA256],
    [artifacts.host.sourceSha256, process.env.LEGACY_NATIVE_HOST_SOURCE_SHA256],
    [artifacts.host.distSha256, process.env.LEGACY_NATIVE_HOST_DIST_SHA256],
  ]) {
    assert.match(expected ?? '', /^[a-f0-9]{64}$/);
    assert.equal(actual, expected);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), `TEST-native-${provider}-capture-`)));
  t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
  for (const name of [
    'home',
    `${provider}-home`,
    'tmp',
    'workspace',
    'store',
    'xdg-config',
    'xdg-data',
    'xdg-cache',
  ])
    await mkdir(join(root, name), { mode: 0o700 });
  const workspace = join(root, 'workspace'),
    file = join(workspace, 'dirty.txt'),
    unrelated = join(workspace, 'unrelated.txt');
  const indexText = CAPTURE_BEFORE.replace('dirty preimage', 'index baseline');
  const unrelatedIndex = 'TEST unrelated index baseline\n',
    unrelatedDirty = 'TEST unrelated DIRTY marker must survive\n';
  const safeEnvironment = {
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    PATH: `${dirname(node)}:${dirname(gitPath)}:/usr/bin:/bin`,
    SHELL: '/bin/sh',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (args: string[]) =>
    execFileSync(gitPath, ['-c', 'core.fsmonitor=false', ...args], {
      cwd: workspace,
      env: safeEnvironment,
      stdio: 'pipe',
    });
  await writeFile(file, indexText);
  await writeFile(unrelated, unrelatedIndex);
  git(['init', '-q']);
  git(['add', '--', 'dirty.txt', 'unrelated.txt']);
  await writeFile(file, CAPTURE_BEFORE);
  await writeFile(unrelated, unrelatedDirty);
  assert.notEqual(indexText, CAPTURE_BEFORE);
  const receiptPath = join(root, 'receipt.json');
  const receipt: Record<string, unknown> = {
    status: 'ISSUED',
    ...(diagnosticObserver ? { diagnosticOnly: true, ordinaryHostQualified: false } : {}),
    root,
    artifacts,
    nativeIssuances: 1,
    scenario: selected.failedShell ? 'failed-shell-partial' : 'qualified-authored-update',
    initial: {
      targetSha256: sha(CAPTURE_BEFORE),
      indexSha256: sha(indexText),
      unrelatedSha256: sha(unrelatedDirty),
    },
    scope: selected.failedShell
      ? 'Actual Host/Runtime/D/native recovered exit7 with original TaskStart input, exact dirty before/final observations and native failure metadata; PARTIAL/nonreviewable, no authorship, hook/background or whole M13 claim.'
      : 'Actual Host/Runtime/D/native provider/local scripted inference with original Host user task.start notified input and one existing LF file update; no vendor, auth, Desktop, create/delete/rename, background tool or whole M13 claim.',
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  let taskId = '';
  let capturePhase: 'assignment' | 'task-start' = 'assignment';
  const model = await selected.startModel({
    root,
    workspace,
    taskId: () => taskId,
    phase: () => capturePhase,
  });
  t.after(() => model.close());
  const namespace = basename(root);
  const owner = {
    ownerId: `TEST-owner-${namespace}`,
    revision: 'TEST-revision',
    storageRoot: join(root, 'store'),
    profileId: `TEST-profile-${namespace}`,
    protocolVersion: 1 as const,
    buildId: 'TEST-native-capture',
    nodeSha256: artifacts.node.sha256,
    hostEntrySha256: artifacts.host.entrySha256,
  };
  const scope = {
    projectId: `TEST-project-${namespace}`,
    workspaceId: `TEST-workspace-${namespace}`,
    teamId: 'TEST-team',
    runId: `TEST-run-${namespace}`,
    memberId: 'human',
    generation: '1',
  };
  const teamBinding = {
    backendId: owner.ownerId,
    teamId: scope.teamId,
    teamName: 'test-native-capture',
  };
  const delivery = {
    ...teamBinding,
    runId: scope.runId,
    memberId: `${member}-id`,
    generation: '1',
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    owner,
    principalId: 'human',
    teams: [
      {
        scope,
        binding: teamBinding,
        members: [{ memberId: `${member}-id`, name: member, role: 'member', delivery }],
        grants: [
          {
            principalId: 'human',
            memberName: 'user',
            permissions: ['read', 'message.write', 'task.write', 'admin'],
          },
          {
            principalId: `${member}-session`,
            memberName: member,
            permissions: ['read', 'message.write', 'task.write'],
          },
        ],
      },
    ],
    runtime: {
      members: [
        await selected.memberProfile({
          root,
          workspace,
          node,
          modelUrl: model.url,
          native,
          teamId: scope.teamId,
          memberId: `${member}-id`,
          principalId: `${member}-session`,
          sessionId: `TEST-session-${namespace}`,
          environment: safeEnvironment,
        }),
      ],
    },
  };
  const profilePath = join(root, 'profile.json'),
    profileBytes = JSON.stringify(profile);
  await writeFile(profilePath, profileBytes, { mode: 0o600 });
  const binding = {
    schemaVersion: 1,
    handleId: `TEST-handle-${namespace}`,
    owner,
    scope,
  };
  const envelope = (commandId: string, payload: unknown) => ({
    commandId,
    binding,
    payload,
  });
  const command = (commandId: string, operation: string, payload: unknown) =>
    envelope(commandId, { operation, payload });
  const startId = 'human-capture-task-start';
  const diagnosticLog = join(root, 'fetch-diagnostic.jsonl');
  if (diagnosticObserver) await writeFile(diagnosticLog, '', { flag: 'wx', mode: 0o600 });
  let current: ReturnType<typeof startHost> | undefined;
  const hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  let nativeChild: ProcessFact | undefined;
  let finalVerificationFailure: Error | undefined;
  const assertNativeAbsent = () => {
    if (!nativeChild) return { qualified: false, reason: 'native-child-not-captured' };
    const table = processFacts();
    const pidPresent = table.some((item) => item.pid === nativeChild!.pid);
    const groupMembers = table.filter((item) => item.groupId === nativeChild!.groupId);
    const observation = { qualified: true, captured: nativeChild, pidPresent, groupMembers };
    assert.equal(pidPresent, false, 'original native PID absent after owned Host cleanup');
    assert.equal(
      groupMembers.length,
      0,
      'original native process group absent after owned Host cleanup'
    );
    return observation;
  };
  try {
    current = startHost({
      node,
      entry,
      root,
      profile: profilePath,
      profileHash: sha(profileBytes),
      gitBinDirectory: dirname(gitPath),
      ...(diagnosticObserver
        ? {
            testImports: [diagnosticObserver.path],
          }
        : {}),
    });
    await current.rpc('host.handshake', { protocolVersion: 1 });
    const opened = await current.rpc(
      'runtime.open',
      envelope('TEST-open', { memberId: `${member}-id` })
    );
    assert.equal(opened.ok, true);
    assert.equal(record(opened.value).nativeReady, true);
    const hostPid = current.child.pid;
    assert.ok(hostPid);
    const children = processFacts().filter(
      (item) => item.parentPid === hostPid && item.command === native.path
    );
    assert.equal(children.length, 1, 'one exact pinned native executable child of captured Host');
    nativeChild = children[0]!;
    assert.equal(
      nativeChild.groupId,
      nativeChild.pid,
      'native owner has an exclusive detached process group'
    );
    receipt.nativeChild = nativeChild;
    const created = await current.rpc(
      'team.execute',
      command('human-capture-task-create', 'task.create', { subject: CAPTURE_TURN, owner: member })
    );
    assert.equal(created.ok, true);
    assert.equal(record(created.value).phase, 'completed');
    taskId = requireId(record(record(created.value).effects).taskId);
    // Owner assignment is its own legitimate product input. Complete it without tools before Start.
    let assignmentInputId = '',
      assignmentTerminal = false;
    const assignmentDeadline = Date.now() + 60_000;
    while (Date.now() < assignmentDeadline) {
      assert.deepEqual(model.failures, []);
      const read: Record<string, unknown> = await current.rpc(
        'runtime.read',
        envelope('TEST-assignment-observe', { memberId: `${member}-id` })
      );
      assert.equal(read.ok, true);
      const inputs = (record(read.value).inputs as unknown[]).map(record);
      assert.ok(inputs.length <= 1, 'only original task-create assignment before explicit Start');
      if (inputs[0]) {
        const observed = requireId(inputs[0].inputId);
        if (assignmentInputId) assert.equal(observed, assignmentInputId);
        assignmentInputId = observed;
        if (inputs[0].phase === 'terminal') {
          assert.equal(inputs[0].terminal, 'succeeded');
          assignmentTerminal = true;
          break;
        }
      }
      await tick();
    }
    assert.ok(
      assignmentTerminal && assignmentInputId,
      'original assignment input reaches terminal without effects'
    );
    const assignmentOutbox = record(
      JSON.parse(
        await readFile(
          join(
            owner.storageRoot,
            'teams',
            teamBinding.teamName,
            '.host-owner/outbox',
            assignmentInputId + '.json'
          ),
          'utf8'
        )
      ) as unknown
    );
    assert.equal(assignmentOutbox.commandId, 'human-capture-task-create');
    assert.equal(assignmentOutbox.inputId, assignmentInputId);
    assert.equal(assignmentOutbox.deliveryId, assignmentInputId);
    assert.equal(assignmentOutbox.phase, 'admitted');
    assert.deepEqual(
      model.observations.map(({ turn, step }) => ({ turn, step })),
      [{ turn: CAPTURE_ASSIGNMENT, step: 0 }]
    );
    assert.equal(await readFile(file, 'utf8'), CAPTURE_BEFORE);
    assert.equal(await readFile(unrelated, 'utf8'), unrelatedDirty);
    receipt.assignment = {
      inputId: assignmentInputId,
      commandId: assignmentOutbox.commandId,
      messageId: assignmentOutbox.messageId,
      contentSha256: sha(String(assignmentOutbox.content)),
      terminal: 'succeeded',
      effects: 'none',
    };
    capturePhase = 'task-start';
    const started = await current.rpc(
      'team.execute',
      command(startId, 'task.start', { taskId, notification: 'user' })
    );
    assert.equal(started.ok, true);
    assert.equal(record(started.value).phase, 'completed');
    receipt.created = created;
    receipt.started = started;
    const startMessageId = requireId(record(record(started.value).effects).messageId);
    const startInputId = effectId(
      'task-notification',
      teamBinding.backendId,
      teamBinding.teamId,
      startId,
      startMessageId
    );
    const deadline = Date.now() + (selected.failedShell ? 180_000 : 60_000);
    let terminal = false;
    while (Date.now() < deadline) {
      assert.deepEqual(model.failures, []);
      const read: Record<string, unknown> = await current.rpc(
        'runtime.read',
        envelope('TEST-observe', { memberId: `${member}-id` })
      );
      assert.equal(read.ok, true);
      const inputs = (record(read.value).inputs as unknown[]).map(record);
      assert.ok(inputs.length <= 2, 'exact original assignment plus explicit TaskStart input only');
      const assignment = inputs.find((input) => input.inputId === assignmentInputId);
      assert.equal(assignment?.phase, 'terminal');
      assert.equal(assignment.terminal, 'succeeded');
      const startedInput = inputs.find((input) => input.inputId === startInputId);
      if (startedInput) {
        if (startedInput.phase === 'terminal') {
          assert.equal(startedInput.terminal, 'succeeded');
          assert.equal(inputs.length, 2);
          terminal = true;
          break;
        }
      }
      const diagnostic = record(read.value).diagnostic;
      assert.ok(
        !['not-sent', 'rejected'].includes(String(startedInput?.phase)),
        `original TaskStart refused: ${String(startedInput?.phase)} / ${String(diagnostic)}`
      );
      assert.notEqual(diagnostic, 'observe-ended', 'original TaskStart observation ended');
      await tick();
    }
    assert.equal(terminal, true, 'bounded original native input terminal');
    assert.equal(await readFile(file, 'utf8'), CAPTURE_AFTER);
    assert.equal(await readFile(unrelated, 'utf8'), unrelatedDirty);
    assert.equal(git(['show', ':dirty.txt']).toString('utf8'), indexText);
    assert.equal(model.observations.length, selected.steps + 1);
    assert.deepEqual(model.failures, []);
    assert.ok(
      model.observations.every((item) => item.contextEffective) &&
        model.observations[0]!.turn === CAPTURE_ASSIGNMENT &&
        model.observations.slice(1).every((item) => item.turn === CAPTURE_TURN)
    );
    const tasks = await current.rpc('team.tasks.list', envelope('TEST-tasks', null));
    assert.equal(tasks.ok, true);
    assert.equal((tasks.value as unknown[]).length, 1);
    assert.equal(record((tasks.value as unknown[])[0]).id, taskId);
    assert.equal(record((tasks.value as unknown[])[0]).status, selected.taskStatus);
    // Original read/receipt recovery may not resubmit or repeat the one native patch.
    const inferenceCount = model.observations.length;
    assert.deepEqual(
      await current.rpc(
        'team.lookup',
        command(startId, 'task.start', { taskId, notification: 'user' })
      ),
      started
    );
    assert.deepEqual(
      await current.rpc(
        'team.execute',
        command(startId, 'task.start', { taskId, notification: 'user' })
      ),
      started
    );
    assert.equal(model.observations.length, inferenceCount);
    const stopped = await current.rpc(
      'runtime.stop',
      envelope('TEST-stop', { memberId: `${member}-id` })
    );
    assert.equal(stopped.ok, true);
    assert.equal(record(stopped.value).phase, 'closed');
    assert.equal(record(stopped.value).custody, 'released');
    await current.close();
    hosts.push(current.facts());
    current = undefined;
    receipt.nativeAfterStop = assertNativeAbsent();
    // Cold read of the existing owners and ledger; no new Runtime/SDK/client is allocated.
    const persisted = new FileRuntimeStore(owner.storageRoot).fenced(delivery, (tx) => tx.get());
    assert.ok(persisted);
    assert.equal(persisted.inputs.length, 2);
    const assignment = persisted.inputs.find(
      (input) => input.intent.inputId === assignmentInputId
    )!;
    assert.ok(assignment);
    assert.equal(assignment.phase, 'terminal');
    assert.equal(assignment.terminal, 'succeeded');
    assert.equal(assignment.intent.messageId, assignmentOutbox.messageId);
    assert.equal(assignment.intent.content, assignmentOutbox.content);
    assert.equal(assignment.fingerprint, deliveryFingerprint(assignment.intent));
    const input: RuntimeInput = persisted.inputs.find(
      (input) => input.intent.inputId === startInputId
    )!;
    assert.ok(input);
    assert.notEqual(input.intent.inputId, assignmentInputId);
    assert.equal(input.phase, 'terminal');
    assert.equal(input.terminal, 'succeeded');
    assert.equal(input.fingerprint, deliveryFingerprint(input.intent));
    const outboxPath = join(
      owner.storageRoot,
      'teams',
      teamBinding.teamName,
      '.host-owner/outbox',
      input.intent.deliveryId + '.json'
    );
    const outbox = record(JSON.parse(await readFile(outboxPath, 'utf8')) as unknown);
    assert.equal(outbox.commandId, startId);
    assert.equal(outbox.messageId, startMessageId);
    assert.equal(outbox.inputId, input.intent.inputId);
    assert.equal(outbox.deliveryId, input.intent.deliveryId);
    assert.equal(outbox.messageId, input.intent.messageId);
    assert.equal(outbox.content, input.intent.content);
    const projectDir = evidenceProjectDir(owner.storageRoot, teamBinding.teamName);
    const eventPath = join(
      projectDir,
      '.board-task-changes/events',
      encodeURIComponent(taskId) + '.jsonl'
    );
    const noticesPath = join(
      projectDir,
      '.board-task-changes/notices',
      encodeURIComponent(taskId) + '.jsonl'
    );
    const events = jsonLines(await readFile(eventPath, 'utf8'));
    assert.equal(events.length, 1);
    const row = events[0]!,
      causal = record(row.causalBinding),
      proof = record(row.nativeCaptureProof);
    assert.equal(row.taskId, taskId);
    assert.equal(causal.taskId, taskId);
    assert.equal(causal.taskStartCommandId, startId);
    for (const key of ['inputId', 'deliveryId', 'messageId'])
      assert.equal(causal[key], input.intent[key as keyof typeof input.intent]);
    assert.equal(causal.operationRef, input.operationRef);
    assert.equal(causal.sessionRef, persisted.sessionRef);
    assert.equal(causal.hostIncarnation, persisted.hostIncarnation);
    assert.deepEqual(causal.binding, normalizeBinding(persisted.binding));
    assert.equal(record(causal.workspace).path, workspace);
    selected.assertNativeEvent(row);
    if (!selected.failedShell) {
      assert.equal(proof.beforeSha256, sha(CAPTURE_BEFORE));
      assert.equal(proof.afterSha256, sha(CAPTURE_AFTER));
    }
    assert.equal(record(row.before).sha256, sha(CAPTURE_BEFORE));
    assert.equal(record(row.after).sha256, sha(CAPTURE_AFTER));
    assert.equal(record(row.before).blobRef, sha(CAPTURE_BEFORE) + '.txt');
    assert.equal(record(row.after).blobRef, sha(CAPTURE_AFTER) + '.txt');
    assert.equal(
      await readFile(
        join(projectDir, '.board-task-changes/blobs', sha(CAPTURE_BEFORE) + '.txt'),
        'utf8'
      ),
      CAPTURE_BEFORE
    );
    assert.equal(
      await readFile(
        join(projectDir, '.board-task-changes/blobs', sha(CAPTURE_AFTER) + '.txt'),
        'utf8'
      ),
      CAPTURE_AFTER
    );
    const notices = jsonLines(await readFile(noticesPath, 'utf8'));
    assert.ok(notices.length > 0);
    if (selected.failedShell) {
      const native = record(causal.native);
      const baseline = notices.find((notice) => notice.capturePhase === 'input-before');
      assert.ok(baseline);
      assert.equal(baseline.captureWindowRef, native.windowRef);
      if (provider === 'codex') assert.equal(baseline.nativeThreadId, native.threadId);
      else assert.equal(baseline.nativeSessionId, native.nativeSessionId);
      const failures = notices.filter((notice) => notice.capturePhase === 'input-failed-tool');
      assert.equal(failures.length, 1);
      assert.equal(failures[0]!.toolUseId, row.toolUseId);
      assert.equal(failures[0]!.reviewableComplete, false);
      assert.deepEqual(failures[0]!.nativeToolOutcome, native);
    } else assert.ok(notices.every((notice) => notice.toolUseId === undefined));
    const changes = await new TaskChangeLedgerReader().readTaskChanges({
      teamName: teamBinding.teamName,
      taskId,
      projectDir,
      projectPath: workspace,
      includeDetails: true,
    });
    assert.ok(changes);
    assert.equal(changes.files.length, 1);
    assert.equal(changes.files[0]!.filePath, file);
    if (selected.failedShell) {
      assert.ok(changes.files[0]!.snippets.length > 0);
      assert.ok(
        changes.files[0]!.snippets.every(
          (snippet) =>
            snippet.ledger?.nativeCapture === 'unqualified' &&
            snippet.ledger.originalFullContent === null &&
            snippet.ledger.modifiedFullContent === null &&
            !snippet.oldString &&
            !snippet.newString
        )
      );
    } else assert.equal(changes.files[0]!.snippets[0]!.ledger!.nativeCapture, 'qualified');
    const content = await new FileContentResolver({ mode: 'ledger-only' }).getFileContent(
      teamBinding.teamName,
      member,
      file,
      changes.files[0]!.snippets
    );
    if (selected.failedShell) {
      assert.equal(content.contentSource, 'unavailable');
      assert.equal(content.originalFullContent, null);
      assert.equal(content.modifiedFullContent, null);
    } else {
      assert.equal(content.originalFullContent, CAPTURE_BEFORE);
      assert.equal(content.modifiedFullContent, CAPTURE_AFTER);
    }
    const review = selected.failedShell
      ? { applied: 0, skipped: 'unqualified-native-failure' }
      : await new ReviewApplier().applyReviewDecisions(
          {
            teamName: teamBinding.teamName,
            taskId,
            decisions: [{ filePath: file, fileDecision: 'rejected', hunkDecisions: {} }],
          },
          new Map([[file, content]])
        );
    assert.equal(review.applied, selected.failedShell ? 0 : 1);
    assert.equal(
      await readFile(file, 'utf8'),
      selected.failedShell ? CAPTURE_AFTER : CAPTURE_BEFORE
    );
    assert.equal(await readFile(unrelated, 'utf8'), unrelatedDirty);
    assert.equal(
      model.observations.length,
      inferenceCount,
      'cold reader/review never spends native input'
    );
    await writeFile(join(root, 'retained-event.json'), JSON.stringify(row, null, 2) + '\n', {
      mode: 0o600,
    });
    await writeFile(
      join(root, 'retained-runtime.json'),
      JSON.stringify(persisted, null, 2) + '\n',
      { mode: 0o600 }
    );
    await writeFile(join(root, 'retained-content.json'), JSON.stringify(content, null, 2) + '\n', {
      mode: 0o600,
    });
    Object.assign(receipt, {
      status: 'PASS',
      taskId,
      runtime: safeRuntime(persisted),
      outbox: {
        commandId: outbox.commandId,
        inputId: outbox.inputId,
        deliveryId: outbox.deliveryId,
        messageId: outbox.messageId,
        contentSha256: sha(String(outbox.content)),
      },
      event: row,
      notices,
      review,
      unrelatedDirtyPreserved: true,
      indexUnchanged: true,
      finalDiskSha256: sha(await readFile(file)),
    });
  } catch (error) {
    receipt.failure =
      error instanceof Error ? { name: error.name, message: error.message } : 'TEST capture failed';
    throw error;
  } finally {
    let cleanupConfirmed = current === undefined;
    try {
      if (current) {
        await current.close();
        cleanupConfirmed = true;
        hosts.push(current.facts());
      }
    } finally {
      await model.close();
      Object.assign(receipt, {
        cleanupConfirmed,
        hosts,
        modelObservations: model.observations,
        modelFailures: model.failures,
      });
      try {
        receipt.nativeAfterCleanup = assertNativeAbsent();
        const fixtureSources = Object.fromEntries(
          await Promise.all(
            Object.keys(artifacts.fixtureSources).map(
              async (relative) => [relative, await fileHash(join(pkg, relative))] as const
            )
          )
        );
        const finalPins = {
          fixtureSources,
          git: {
            path: await realpath(gitPath),
            sha256: await fileHash(gitPath),
          },
          ...(diagnosticObserver
            ? {
                diagnosticObserver: {
                  path: await realpath(diagnosticObserver.path),
                  sha256: await fileHash(diagnosticObserver.path),
                },
              }
            : {}),
          host: {
            entrySha256: await fileHash(entry),
            sourceSha256: await treeHash(join(pkg, 'src'), '.ts'),
            distSha256: await treeHash(join(pkg, 'dist'), '.js'),
          },
          nativeSha256: await fileHash(native.path),
          providerSha256: await fileHash(artifacts.provider.path),
          nodeSha256: await fileHash(node),
        };
        receipt.finalPins = finalPins;
        assert.deepEqual(finalPins.git, artifacts.git, 'verified direct Git unchanged');
        if (diagnosticObserver) {
          assert.deepEqual(
            finalPins.diagnosticObserver,
            diagnosticObserver,
            'TEST observer bytes unchanged'
          );
          receipt.diagnostics = {
            path: diagnosticLog,
            sha256: await fileHash(diagnosticLog),
            sizeBytes: (await stat(diagnosticLog)).size,
          };
        }
        assert.deepEqual(
          finalPins.fixtureSources,
          artifacts.fixtureSources,
          'all executed TEST fixture sources unchanged'
        );
        assert.equal(finalPins.host.entrySha256, artifacts.host.entrySha256);
        assert.equal(
          finalPins.host.sourceSha256,
          artifacts.host.sourceSha256,
          'Host source frozen through native and cold review'
        );
        assert.equal(
          finalPins.host.distSha256,
          artifacts.host.distSha256,
          'Host compiled output frozen through native and cold review'
        );
        assert.equal(finalPins.nativeSha256, artifacts.native.sha256);
        assert.equal(finalPins.providerSha256, artifacts.provider.sha256);
        assert.equal(finalPins.nodeSha256, artifacts.node.sha256);
        receipt.sourcePinsUnchanged = true;
      } catch (error) {
        receipt.status = 'FAILED-final-verification';
        receipt.finalVerificationFailure =
          error instanceof Error ? error.message : 'TEST final verification failed';
        finalVerificationFailure =
          error instanceof Error ? error : new Error('TEST final verification failed');
      } finally {
        await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
      }
    }
  }
  if (finalVerificationFailure) throw finalVerificationFailure;
}

function safeRuntime(value: RuntimeSessionRecord) {
  return {
    binding: value.binding,
    profileId: value.profileId,
    hostIncarnation: value.hostIncarnation,
    sessionRef: value.sessionRef,
    phase: value.phase,
    custody: value.custody,
    inputs: value.inputs.map((input) => ({
      inputId: input.intent.inputId,
      deliveryId: input.intent.deliveryId,
      messageId: input.intent.messageId,
      operationRef: input.operationRef,
      fingerprint: input.fingerprint,
      phase: input.phase,
      terminal: input.terminal,
    })),
  };
}

export interface ProcessFact {
  pid: number;
  parentPid: number;
  groupId: number;
  birth: string;
  command: string;
}
/** Read-only custody observation; signaling stays exclusively with the captured Host. */
export function processFacts(): ProcessFact[] {
  const output = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,comm='], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  });
  const lines = output.trim().split('\n');
  assert.ok(lines.length <= 20_000, 'bounded physical process observation');
  return lines.map((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
        line
      );
    assert.ok(match, 'physical observation includes original native birth identity');
    return {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      groupId: Number(match[3]),
      birth: match[4]!,
      command: match[5]!.trim(),
    };
  });
}

/** Pure oracle shared by the selected provider fixtures; no native work or file effects. */
export function assertFailedToolCapture(
  row: Record<string, unknown>,
  provider: 'codex' | 'opencode',
  before: string,
  after: string
): Record<string, unknown> {
  const causal = record(row.causalBinding),
    native = record(causal.native);
  assert.equal(row.toolStatus, 'failed');
  assert.equal(row.source, 'shell_snapshot');
  assert.equal(row.executionSeq, 0);
  assert.equal(row.nativeCaptureProof, undefined);
  assert.equal(causal.toolName, 'Bash');
  assert.equal(record(causal.provenance).reviewableComplete, false);
  assert.equal(native.provider, provider);
  assert.equal(native.exitCode, 7);
  assert.ok(typeof native.windowRef === 'string' && native.windowRef);
  assert.match(String(native.commandSha256), /^[a-f0-9]{64}$/);
  assert.equal(record(row.before).sha256, sha(before));
  assert.equal(record(row.after).sha256, sha(after));
  return native;
}
