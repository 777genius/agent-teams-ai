import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentChangeLedgerReader, TaskChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { RuntimeTeamCoordinator } from '../dist/composition/RuntimeTeamCoordinator.js';
import { createHostTeamReview } from '../dist/composition/HostTeamReview.js';
import { FileContentResolver } from '@agent-teams/task-change-ledger/review-content';
import { BOUND_REVIEW_TEAM } from '@agent-teams/task-change-ledger/review-transport';
import { initialContextDigest } from '../dist/team-launch/context.js';
import { evidenceProjectDir } from '../dist/evidence/evidenceProjectDir.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { MemberProviderContext } from '../dist/adapters/providers/MemberProvider.js';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';
import type { TestContext } from 'node:test';

// Observation budget only: awaited coordinator pumps include durable filesystem writes.
const OBSERVATION_TIMEOUT_MS = 30_000;

async function fixture(t: TestContext, absentWorkspace = false, registered = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-claude-evidence-composition-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const file = join(workspace, 'dirty.txt');
  writeFileSync(file, 'TEST initially dirty\n');
  for (const args of [
    ['init', '-q'],
    ['add', 'dirty.txt'],
  ])
    execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-evidence' };
  const definition: TeamHostProfile['teams'][number] = {
    binding,
    scope: {
      projectId: 'TEST-project',
      workspaceId: 'TEST-workspace',
      teamId: binding.teamId,
      runId: 'TEST-run',
      memberId: 'human',
      generation: '1',
    },
    members: [
      {
        memberId: 'worker-id',
        name: 'worker',
        role: registered ? 'lead' : 'member',
        ...(registered ? {} : { delivery: { ...binding, runId: 'TEST-run', memberId: 'worker-id', generation: '1' } }),
      },
    ],
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
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'human',
    owner: {
      ownerId: binding.backendId,
      profileId: 'TEST-profile',
      revision: 'TEST-revision',
      storageRoot: join(root, 'storage'),
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    teams: [definition],
    runtime: {
      members: [
        {
          provider: 'claude',
          teamId: binding.teamId,
          memberId: 'worker-id',
          principalId: 'worker-principal',
          sessionId: 'TEST-native',
          generation: 1,
          configRevision: 'TEST-config',
          model: 'TEST-model',
          accountBinding: 'TEST-account',
          cwd: absentWorkspace ? join(root, 'missing') : workspace,
          executable: { path: '/TEST/no-native-process', sha256: 'a'.repeat(64) },
          environment: { HOME: root, CLAUDE_CONFIG_DIR: root, PATH: '/TEST/bin' },
          nativeTools: ['Write', 'Bash'],
          autoAllowedTools: [],
          limits: {
            queuedInputs: 8,
            inputBytes: 65536,
            outputBytes: 65536,
            outputEvents: 256,
            pendingInteractions: 8,
            timeoutMs: 1000,
          },
        },
      ],
    },
  };
  if (registered) profile.runtime = { members: [], providerTemplates: [profile.runtime!.members[0]!] };
  const owner = createFilesystemTeamOwner({
    root: profile.owner.storageRoot,
    binding,
    members: definition.members.map(({ name, memberId, role, delivery }) => ({
      name,
      memberId,
      role,
      ...(delivery ? { delivery } : {}),
    })),
    ...(registered ? { savedSettings: { cwd: workspace, providerId: 'anthropic' as const },
      assertRosterEditable: (members: readonly import('../dist/team/contracts.js').TeamMember[]) => runtime.assertRosterEditable(binding.teamId, members) } : {}),
    grants: definition.grants.map(({ principalId, memberName, permissions }) => ({
      principalId,
      memberName,
      permissions,
    })),
  });
  const connection = owner.connect('human');
  const team = { definition, owner, connection, operatorPrincipalId: 'human' };
  const store = new TeamOwnerStore(profile.owner.storageRoot, binding.teamName);
  let context!: MemberProviderContext;
  let current = true;
  const inputs: Input[] = [];
  const restored: unknown[] = [];
  let opens = 0;
  let session!: Session;
  let finishInput!: (inputId?: string, observed?: () => void) => void;
  function providerSession(received: MemberProviderContext): Session {
    let closed = false, wake: (() => void) | undefined;
    const events: { value: Event; observed?: () => void }[] = [];
    const driver: Session = {
      sessionRef: `TEST-native-${++opens}`,
      submit: async input => { inputs.push(input); return { ok: true, value: {
        inputId: input.inputId, operationRef: input.operationRef, delivery: 'client-consumed', providerAcceptance: 'unknown' } }; },
      observe: async function* () {
        while (!closed || events.length) {
          const event = events.shift();
          if (event) { yield event.value; received.onProgress(); event.observed?.(); }
          else await new Promise<void>(resolve => { wake = resolve; });
        }
      },
      respondToInteraction: async () => ({ ok: false, code: 'unsupported' }),
      interrupt: async () => ({ ok: false, code: 'unsupported' }),
      checkpoint: () => registered ? { ok: true, value: { history: inputs.map(input => input.content) } } : { ok: false, code: 'unsupported' },
      checkReadiness: async () => ({ ok: true, value: undefined }),
      close: async () => { closed = true; wake?.(); return { logicallyClosed: true, cleanup: 'confirmed' }; },
    };
    finishInput = (inputId?: string, observed?: () => void) => {
      const input = inputId ? inputs.find(input => input.inputId === inputId)! : inputs.at(-1)!;
      assert.ok(input);
      events.push({ value: { kind: 'result', sessionRef: driver.sessionRef, inputId: input.inputId,
        operationRef: input.operationRef, outcome: 'succeeded' }, ...(observed ? { observed } : {}) });
      wake?.(); wake = undefined;
    };
    return driver;
  }
  const runtime = new RuntimeTeamCoordinator({
    profile,
    teams: new Map([[binding.teamId, team]]),
    assertWriter() {
      if (!current) throw new Error('TEST lease lost');
    },
    createProvider(received) {
      context = received;
      const driver = session = providerSession(received);
      return {
        factory: {
          open: async () => {
            if (received.request.checkpointRef) restored.push(await received.readCheckpoint(received.request.checkpointRef, received.request));
            return { driver, capabilities: [...received.request.requiredCapabilities] };
          },
        },
        isReady: () => received.isCurrent(),
        initialContextEvidence: () => ({
          kind: 'native-configuration',
          contextDigest: initialContextDigest(received.instructions),
          generation: received.endpoint.binding.generation,
          configRevision: received.request.configRevision,
        }),
        seal: () => received.toolEvidence?.seal(),
        cleanup: async () => true,
      };
    },
  });
  t.after(async () => {
    current = true;
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  if (registered) {
    connection.replaceRoster({ commandId: 'TEST-captured-roster', expectedRevision: connection.readRoster().revision, members: [],
      savedSettings: { cwd: workspace, providerId: 'anthropic' } });
    await runtime.executeLaunch(binding.teamId, 'capture', 'TEST-captured-runtime', { rosterCommandId: 'TEST-captured-roster' });
  }
  await runtime.execute(binding.teamId, 'open', { memberId: 'worker-id' });
  assert.ok(
    context.toolEvidence,
    'actual coordinator provider configuration receives capture port'
  );
  const createAndStart = () => {
    const created = connection.execute({
      commandId: 'TEST-create',
      operation: 'task.create',
      payload: { subject: 'TEST exact input', owner: 'worker' },
    });
    const started = connection.execute({
      commandId: 'TEST-start',
      operation: 'task.start',
      payload: { taskId: created.effects.taskId, notification: 'user' },
    });
    return { taskId: created.effects.taskId, commandId: started.commandId };
  };
  const dispatch = async (commandId = 'TEST-start', expectedGeneration?: string) => {
    await runtime.settleTeamCommands(binding.teamId);
    const intents = store.list<import('../dist/team/contracts.js').DeliveryIntent>('outbox')
      .filter(intent => intent.commandId === commandId);
    assert.equal(intents.length, 1, 'one original persisted command/outbox cause');
    const target = intents[0]!;
    const deadline = Date.now() + OBSERVATION_TIMEOUT_MS, finished = new Set<string>();
    let input: Input | undefined;
    while (Date.now() < deadline) {
      await runtime.execute(binding.teamId, 'dispatch', { memberId: 'worker-id',
        ...(expectedGeneration ? { expectedGeneration } : {}) });
      const state = await runtime.execute(binding.teamId, 'read', { memberId: 'worker-id',
        ...(expectedGeneration ? { expectedGeneration } : {}) }) as { inputs: {inputId: string; phase: string}[] };
      assert.ok(state.inputs.length <= 8);
      for (const row of state.inputs) if (row.phase === 'consumed' && row.inputId !== target.inputId && !finished.has(row.inputId)) {
        finished.add(row.inputId);
        await new Promise<void>(resolve => finishInput(row.inputId, resolve));
      }
      if (state.inputs.some(row => row.inputId === target.inputId && row.phase === 'consumed')) {
        input = inputs.find(input => input.inputId === target.inputId); break;
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(input, 'original owner outbox input must reach actual Runtime consumed phase');
    assert.equal(input.inputId, target.inputId);
    return {
      phase: 'before' as const,
      sessionRef: session.sessionRef,
      inputId: input.inputId,
      operationRef: input.operationRef,
      toolUseId: 'TEST-tool',
      toolName: 'Write',
      toolInput: { file_path: file },
      signal: new AbortController().signal,
    };
  };
  const revoke = (principal: string) => {
    const state = store.read<{ grants: { principalId: string; revoked?: boolean }[] }>(
      'state.json'
    )!;
    state.grants.find((grant) => grant.principalId === principal)!.revoked = true;
    store.write('state.json', state);
  };
  return {
    root,
    team,
    profile,
    workspace,
    file,
    get context() { return context; },
    restored,
    submittedInputs: inputs,
    opens: () => opens,
    finishInput,
    finishAndObserve: (inputId: string) => new Promise<void>(resolve => finishInput(inputId, resolve)),
    owner,
    connection,
    runtime,
    store,
    binding,
    createAndStart,
    dispatch,
    revoke,
    projectDir: evidenceProjectDir(profile.owner.storageRoot, binding.teamName),
    loseLease: () => {
      current = false;
    },
  };
}

test('actual coordinator capture port binds notified task.start input and writes exact observed filesystem bytes', async (t) => {
  const f = await fixture(t),
    task = f.createAndStart();
  const request = await f.dispatch();
  await f.context.toolEvidence!.observe(request);
  writeFileSync(f.file, 'TEST composed final\n');
  await f.context.toolEvidence!.observe({ ...request, phase: 'after', outcome: 'failed' });
  await f.context.toolEvidence!.observeBatch!({
    ...request,
    boundary: 'post-tool-use-hooks',
    tools: [
      {
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        toolInput: request.toolInput,
        outcome: 'failed',
      },
    ],
  });
  const view = await new TaskChangeLedgerReader().readTaskChanges({
    teamName: f.binding.teamName,
    taskId: task.taskId,
    projectDir: f.projectDir,
    projectPath: f.workspace,
    includeDetails: true,
  });
  assert.equal(view!.files[0]!.snippets[0]!.ledger!.originalFullContent, null);
  assert.equal(view!.files[0]!.snippets[0]!.ledger!.modifiedFullContent, null);
  const event = JSON.parse(
    readFileSync(
      join(f.projectDir, '.board-task-changes', 'events', `${task.taskId}.jsonl`),
      'utf8'
    )
  ) as {
    causalBinding: { taskStartCommandId: string; inputId: string; workspace: { path: string } };
    executionSeq: number;
    warnings: string[];
    before: { blobRef: string };
    after: { blobRef: string };
  };
  assert.equal(event.causalBinding.taskStartCommandId, task.commandId);
  assert.equal(event.causalBinding.inputId, request.inputId);
  assert.equal(event.causalBinding.workspace.path, f.workspace);
  assert.equal(readFileSync(join(f.projectDir, '.board-task-changes', 'blobs', event.before.blobRef), 'utf8'), 'TEST initially dirty\n');
  assert.equal(readFileSync(join(f.projectDir, '.board-task-changes', 'blobs', event.after.blobRef), 'utf8'), 'TEST composed final\n');
  assert.equal(event.executionSeq, 0);
  assert.ok(event.warnings.some((warning) => warning.includes('not qualified')));
});

test('generic delivered DM uses its original agent artifact through actual coordinator provider port', async (t) => {
  const f = await fixture(t);
  f.connection.execute({
    commandId: 'TEST-dm',
    operation: 'message.send',
    payload: { to: 'worker', text: 'TEST generic input' },
  });
  const request = { ...await f.dispatch('TEST-dm'), toolInput: { file_path: f.file, content: 'TEST generic final\n' } };
  await f.context.toolEvidence!.observe(request);
  assert.equal(f.context.toolEvidence!.readStatus().phase, 'capturing');
  writeFileSync(f.file, 'TEST generic final\n');
  await f.context.toolEvidence!.observe({ ...request, phase: 'after', outcome: 'succeeded' });
  await f.context.toolEvidence!.observeBatch!({
    ...request,
    boundary: 'post-tool-use-hooks',
    tools: [
      {
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        toolInput: request.toolInput,
        outcome: 'succeeded',
      },
    ],
  });
  const changes = await new AgentChangeLedgerReader().readAgentChanges({
    teamName: f.binding.teamName,
    memberName: 'worker',
    actorId: 'worker-id',
    projectDir: f.projectDir,
    projectPath: f.workspace,
  });
  assert.equal(changes.files[0]!.snippets[0]!.ledger!.modifiedFullContent, 'TEST generic final\n');
  assert.equal(changes.files[0]!.snippets[0]!.ledger!.taskId, undefined);
  assert.equal(existsSync(join(f.projectDir, '.board-task-changes', 'events')), false);
});

test('member revocation and writer lease loss suppress late composed capture writes', async (t) => {
  for (const mode of ['member', 'lease'] as const) {
    const f = await fixture(t),
      task = f.createAndStart(),
      request = await f.dispatch();
    await f.context.toolEvidence!.observe(request);
    const notice = join(f.projectDir, '.board-task-changes', 'notices', `${task.taskId}.jsonl`);
    const original = readFileSync(notice, 'utf8');
    if (mode === 'member') f.revoke('worker-principal');
    else f.loseLease();
    await f.context.toolEvidence!.observe({ ...request, phase: 'after', outcome: 'succeeded' });
    assert.equal(readFileSync(notice, 'utf8'), original);
    assert.equal(existsSync(join(f.projectDir, '.board-task-changes', 'events')), false);
  }
});

test('operator revocation at synchronous publication fence prevents before artifacts', async (t) => {
  const f = await fixture(t);
  f.createAndStart();
  const request = await f.dispatch();
  const original = f.owner.withLaunchAuthority.bind(f.owner);
  let once = true;
  f.owner.withLaunchAuthority = (principal, action, callback) => {
    if (once) {
      once = false;
      f.revoke('human');
    }
    return original(principal, action, callback);
  };
  await f.context.toolEvidence!.observe(request);
  assert.equal(existsSync(f.projectDir), false);
});

test('unavailable canonical workspace yields gap port while ordinary controlled provider opens', async (t) => {
  const f = await fixture(t, true);
  assert.deepEqual(f.context.toolEvidence!.readStatus(), {
    phase: 'gap',
    reason: 'capture-context-unavailable',
  });
  assert.equal(existsSync(f.projectDir), false);
});


async function capturedWorktreeReview(t: TestContext) {
  const f = await fixture(t);
  const task = f.createAndStart();
  const request = { ...await f.dispatch(), toolInput: { file_path: f.file, content: 'TEST captured worktree final\n' } };
  await f.context.toolEvidence!.observe(request);
  assert.equal(f.context.toolEvidence!.readStatus().phase, 'capturing', JSON.stringify({ before: f.context.toolEvidence!.readStatus(), runtime: await f.runtime.execute(f.binding.teamId, 'read', { memberId: 'worker-id' }) }));
  writeFileSync(f.file, request.toolInput.content);
  await f.context.toolEvidence!.observe({ ...request, phase: 'after', outcome: 'succeeded' });
  await f.context.toolEvidence!.observeBatch!({ ...request, boundary: 'post-tool-use-hooks',
    tools: [{ toolUseId: request.toolUseId, toolName: request.toolName, toolInput: request.toolInput, outcome: 'succeeded' }] });
  assert.ok(existsSync(join(f.projectDir, '.board-task-changes', 'events', `${task.taskId}.jsonl`)),
    JSON.stringify({ status: f.context.toolEvidence!.readStatus(), notices: existsSync(join(f.projectDir, '.board-task-changes', 'notices', `${task.taskId}.jsonl`))
      ? readFileSync(join(f.projectDir, '.board-task-changes', 'notices', `${task.taskId}.jsonl`), 'utf8') : 'none' }));
  await f.runtime.close();
  const main = join(f.root, 'main-a'), later = join(f.root, 'main-c');
  mkdirSync(main); mkdirSync(later);
  writeFileSync(join(main, 'dirty.txt'), 'TEST main A unrelated\n');
  writeFileSync(join(later, 'dirty.txt'), 'TEST main C unrelated\n');
  let selectedMain = main, reviewCurrent = true;
  const origin = { taskId: task.taskId, memberName: 'worker' };
  const open = () => {
    const service = createHostTeamReview({ team: f.team, ownerStorageRoot: f.profile.owner.storageRoot,
      principalId: 'human', currentProjectPath: () => selectedMain,
      initialRuntimeMembers: f.profile.runtime!.members, assertCurrent() { if (!reviewCurrent) throw new Error('TEST review context replaced'); }, processStartProbe: async () => 1 });
    t.after(() => service.dispose());
    return service;
  };
  const content = (service: ReturnType<typeof open>) => service.invoke({ method: 'getFileContent',
    args: [BOUND_REVIEW_TEAM, 'worker', f.file, []] }, origin);
  return { ...f, task, origin, main, later, open, content, replaceReviewContext: () => { reviewCurrent = false; }, selectLater: () => { selectedMain = later; } };
}

test('captured Task and agent worktree bytes survive main cwd change and review reopen without retargeting', async (t) => {
  const f = await capturedWorktreeReview(t);
  const first = f.open();
  const taskView = await first.getTaskChanges(f.task.taskId);
  assert.equal(taskView.scope?.memberName, 'worker');
  assert.equal(taskView.scope?.primaryAgentId, 'worker-id');
  const shown = await f.content(first);
  assert.equal(shown.method, 'getFileContent');
  if (shown.method !== 'getFileContent') throw new Error('Wrong content projection');
  assert.equal(shown.result.originalFullContent, 'TEST initially dirty\n');
  assert.equal(shown.result.modifiedFullContent, 'TEST captured worktree final\n');
  const changed = await first.invoke({ method: 'saveEditedFile', args: [
    { teamName: BOUND_REVIEW_TEAM, ...f.origin }, f.file, 'TEST historical review edit\n', 'TEST captured worktree final\n',
  ] }, f.origin, { commandId: 'TEST-worktree-review-edit' });
  assert.partialDeepStrictEqual(changed, { method: 'saveEditedFile', result: { success: true } });
  first.dispose();
  f.selectLater();
  const reopened = f.open();
  const historical = await f.content(reopened);
  if (historical.method !== 'getFileContent') throw new Error('Wrong content projection');
  assert.equal(historical.result.originalFullContent, shown.result.originalFullContent);
  assert.equal(historical.result.modifiedFullContent, shown.result.modifiedFullContent);
  const agent = await reopened.invoke({ method: 'getFileContent', args: [BOUND_REVIEW_TEAM, 'worker', f.file, []] }, { memberName: 'worker' });
  if (agent.method !== 'getFileContent') throw new Error('Wrong agent projection');
  assert.equal(agent.result.modifiedFullContent, shown.result.modifiedFullContent);
  assert.partialDeepStrictEqual(await reopened.lookupCommand('TEST-worktree-review-edit', f.origin), { phase: 'completed', responseAvailable: true });
  assert.equal(readFileSync(f.file, 'utf8'), 'TEST historical review edit\n');
  const agentEdit = await reopened.invoke({ method: 'saveEditedFile', args: [
    { teamName: BOUND_REVIEW_TEAM, memberName: 'worker' }, f.file, 'TEST agent scoped edit\n', 'TEST historical review edit\n',
  ] }, { memberName: 'worker' }, { commandId: 'TEST-worktree-agent-edit' });
  assert.partialDeepStrictEqual(agentEdit, { method: 'saveEditedFile', result: { success: true } });
  assert.equal(readFileSync(f.file, 'utf8'), 'TEST agent scoped edit\n');
  const scopedWatch = await reopened.authorizeWatch({ projectPath: f.later, filePaths: [f.file], scope: f.origin });
  assert.equal(scopedWatch.projectPath, f.workspace);
  assert.deepEqual(scopedWatch.roots, [{ projectPath: f.workspace, filePaths: [f.file] }]);
  assert.ok(scopedWatch.authorizationIdentity);
  assert.deepEqual(await reopened.getGitFileLog(f.later, f.file, f.origin), []);
  await assert.rejects(reopened.authorizeWatch({ projectPath: f.later, filePaths: [join(f.later, 'dirty.txt')], scope: f.origin }));
  await assert.rejects(reopened.authorizeWatch({ projectPath: f.later, filePaths: [f.file], scope: { taskId: f.task.taskId, memberName: 'forged' } }));

  assert.equal(readFileSync(join(f.main, 'dirty.txt'), 'utf8'), 'TEST main A unrelated\n');
  assert.equal(readFileSync(join(f.later, 'dirty.txt'), 'utf8'), 'TEST main C unrelated\n');
  await assert.rejects(reopened.authorizeWatch({ projectPath: f.workspace, filePaths: [f.file] }));
  await assert.rejects(reopened.getGitFileLog(f.workspace, f.file));
  const full = await new TaskChangeLedgerReader().readTaskChangesWithEvidence({ teamName: f.binding.teamName,
    taskId: f.task.taskId, projectDir: f.projectDir, includeDetails: true });
  assert.equal(full.evidence[0]!.workspaceRoot, f.workspace);
  assert.ok(!('evidence' in historical.result), 'private workspace metadata is not transported');
  f.replaceReviewContext();
  await assert.rejects(reopened.authorizeWatch({ projectPath: f.later, filePaths: [f.file], scope: f.origin }), /context replaced/);
  await assert.rejects(reopened.getGitFileLog(f.later, f.file, f.origin), /context replaced/);
});

test('captured root inode and original source guards reject after awaits and never grant a replacement or symlink', async (t) => {
  const f = await capturedWorktreeReview(t), service = f.open();
  await f.content(service);
  const original = FileContentResolver.prototype.getFileContent;
  let replaced = false;
  FileContentResolver.prototype.getFileContent = async function (...args) {
    const result = await original.apply(this, args);
    if (!replaced) {
      replaced = true;
      renameSync(f.workspace, f.workspace + '-retained');
      mkdirSync(f.workspace);
      writeFileSync(f.file, 'TEST replacement unrelated\n');
    }
    return result;
  };
  try { await assert.rejects(f.content(service), /workspace (changed|replaced)/); }
  finally { FileContentResolver.prototype.getFileContent = original; }
  assert.equal(replaced, true);
  await assert.rejects(service.authorizeWatch({ projectPath: f.main, filePaths: [f.file], scope: f.origin }));
  await assert.rejects(service.getGitFileLog(f.main, f.file, f.origin));
  await assert.rejects(service.invoke({ method: 'saveEditedFile', args: [
    { teamName: BOUND_REVIEW_TEAM, ...f.origin }, f.file, 'MUST NOT WRITE', 'TEST replacement unrelated\n',
  ] }, f.origin, { commandId: 'TEST-replaced-root' }));
  assert.equal(readFileSync(f.file, 'utf8'), 'TEST replacement unrelated\n');
  rmSync(f.workspace, { recursive: true });
  symlinkSync(f.workspace + '-retained', f.workspace, 'dir');
  await assert.rejects(f.content(f.open()), /Captured review source changed|Captured review workspace|Captured workspace unavailable/);
  assert.equal(readFileSync(f.file, 'utf8'), 'TEST captured worktree final\n');
  rmSync(f.workspace);
  renameSync(f.workspace + '-retained', f.workspace);
  const current = f.open();
  const options = f.profile.runtime!.members[0]!;
  const originalCwd = options.cwd;
  FileContentResolver.prototype.getFileContent = async function (...args) {
    const result = await original.apply(this, args);
    options.cwd = f.later;
    return result;
  };
  try { await assert.rejects(f.content(current), /initial workspace source changed/); }
  finally { FileContentResolver.prototype.getFileContent = original; options.cwd = originalCwd; }
  const state = f.store.read<{ members: { memberId: string; name: string }[] }>('state.json')!;
  FileContentResolver.prototype.getFileContent = async function (...args) {
    const result = await original.apply(this, args);
    f.store.write('state.json', { ...state, members: state.members.map(member => ({ ...member, name: 'renamed-worker' })) });
    return result;
  };
  try { await assert.rejects(f.content(current), /actor label changed or ambiguous/); }
  finally { FileContentResolver.prototype.getFileContent = original; f.store.write('state.json', state); }
  f.revoke('human');
  await assert.rejects(f.content(current));
  await assert.rejects(current.authorizeWatch({ projectPath: f.main, filePaths: [f.file], scope: f.origin }));
  await assert.rejects(current.getGitFileLog(f.main, f.file, f.origin));
});

test('registered captured workspace survives an actual selected checkpoint restore with original event/input IDs', { timeout: 180_000 }, async (t) => {
  const f = await fixture(t, false, true), task = f.createAndStart();
  const request = { ...await f.dispatch(), toolInput: { file_path: f.file, content: 'TEST registered original final\n' } };
  await f.context.toolEvidence!.observe(request);
  assert.equal(f.context.toolEvidence!.readStatus().phase, 'capturing', JSON.stringify({ before: f.context.toolEvidence!.readStatus(), runtime: await f.runtime.execute(f.binding.teamId, 'read', { memberId: 'worker-id' }) }));
  writeFileSync(f.file, request.toolInput.content);
  await f.context.toolEvidence!.observe({ ...request, phase: 'after', outcome: 'succeeded' });
  await f.context.toolEvidence!.observeBatch!({ ...request, boundary: 'post-tool-use-hooks', tools: [
    { toolUseId: request.toolUseId, toolName: request.toolName, toolInput: request.toolInput, outcome: 'succeeded' },
  ] });
  const ledger = join(f.projectDir, '.board-task-changes', 'events', `${task.taskId}.jsonl`);
  const originalBytes = readFileSync(ledger, 'utf8');
  const event = JSON.parse(originalBytes) as { eventId: string; causalBinding: { inputId: string; binding: { generation: string } } };
  assert.equal(event.causalBinding.inputId, request.inputId);
  await f.finishAndObserve(request.inputId);
  const finished = new Set([request.inputId]);
  let settled = false;
  let lastInputPhases: { inputId: string; phase: string }[] = [];
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const read = await f.runtime.execute(f.binding.teamId, 'read', { memberId: 'worker-id' }) as { inputs: { inputId: string; phase: string }[] };
    assert.ok(read.inputs.length <= 8);
    lastInputPhases = read.inputs.map(({ inputId, phase }) => ({ inputId, phase }));
    for (const input of read.inputs) if (input.phase === 'consumed' && !finished.has(input.inputId)) {
      finished.add(input.inputId); await f.finishAndObserve(input.inputId);
    }
    if (read.inputs.length > 1 && read.inputs.every(input => input.phase === 'terminal')) { settled = true; break; }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(settled, true, `actual Runtime persisted provider result before checkpoint: ${JSON.stringify(lastInputPhases)}`);
  const checkpoint = await f.runtime.execute(f.binding.teamId, 'checkpoint', { memberId: 'worker-id', checkpointId: 'TEST-review-original' }) as { status: string; reference: string };
  if (checkpoint.status !== 'published') t.diagnostic(JSON.stringify({ checkpoint, runtime: await f.runtime.execute(f.binding.teamId, 'read', { memberId: 'worker-id' }) }));
  assert.equal(checkpoint.status, 'published');
  await f.runtime.execute(f.binding.teamId, 'stop', { memberId: 'worker-id' });
  const restored = await f.runtime.execute(f.binding.teamId, 'restore', { memberId: 'worker-id',
    reference: checkpoint.reference, expectedGeneration: event.causalBinding.binding.generation }, 'TEST-review-restore') as { generation: string };
  assert.notEqual(restored.generation, event.causalBinding.binding.generation);
  assert.equal(f.opens(), 2);
  assert.equal(f.restored.length, 1);
  assert.deepEqual(f.restored[0], { history: f.submittedInputs.map(input => input.content) });
  const selection = f.runtime.executeLaunch(f.binding.teamId, 'restorations.read', 'TEST-read-restorations', {
    launchId: f.owner.runtimeCaptures('human')[0]!.launchId,
  }) as { restorations: { commandId: string; reference: string; sourceGeneration: string; selectedGeneration: string }[] };
  assert.partialDeepStrictEqual(selection.restorations[0], { commandId: 'TEST-review-restore', reference: checkpoint.reference,
    sourceGeneration: event.causalBinding.binding.generation, selectedGeneration: restored.generation });
  // A fresh restored-generation input must bind the full checkpoint-bearing open request.
  // Reviewing old bytes alone does not exercise the new provider's evidence capture port.
  assert.equal(f.context.request.checkpointRef, checkpoint.reference);
  f.connection.execute({
    commandId: 'TEST-restored-evidence-dm',
    operation: 'message.send',
    payload: { to: 'worker', text: 'TEST fresh restored evidence input' },
  });
  const resumedRequest = {
    ...await f.dispatch('TEST-restored-evidence-dm', restored.generation),
    toolUseId: 'TEST-restored-tool',
    toolInput: { file_path: f.file, content: 'TEST restored generation final\n' },
  };
  assert.notEqual(resumedRequest.inputId, request.inputId);
  await f.context.toolEvidence!.observe(resumedRequest);
  assert.equal(f.context.toolEvidence!.readStatus().phase, 'capturing',
    'restored capture must match checkpointRef in the current Runtime config');
  writeFileSync(f.file, resumedRequest.toolInput.content);
  await f.context.toolEvidence!.observe({ ...resumedRequest, phase: 'after', outcome: 'succeeded' });
  await f.context.toolEvidence!.observeBatch!({
    ...resumedRequest,
    boundary: 'post-tool-use-hooks',
    tools: [{ toolUseId: resumedRequest.toolUseId, toolName: resumedRequest.toolName,
      toolInput: resumedRequest.toolInput, outcome: 'succeeded' }],
  });
  const resumedChanges = await new AgentChangeLedgerReader().readAgentChanges({
    teamName: f.binding.teamName,
    memberName: 'worker',
    actorId: 'worker-id',
    projectDir: f.projectDir,
    projectPath: f.workspace,
  });
  assert.ok(resumedChanges.files.some(file => file.snippets.some(snippet =>
    snippet.ledger?.modifiedFullContent === resumedRequest.toolInput.content)),
    'fresh restored input must publish its own observed evidence');
  assert.equal(readFileSync(ledger, 'utf8'), originalBytes,
    'fresh restored input does not rewrite historical task evidence');
  await f.finishAndObserve(resumedRequest.inputId);
  await f.runtime.execute(f.binding.teamId, 'stop', { memberId: 'worker-id', expectedGeneration: restored.generation });
  const later = join(f.root, 'later-main'); mkdirSync(later);
  const review = createHostTeamReview({ team: f.team, ownerStorageRoot: f.profile.owner.storageRoot, principalId: 'human',
    currentProjectPath: () => later, initialRuntimeMembers: [], assertCurrent() {}, processStartProbe: async () => 1 });
  t.after(() => review.dispose());
  const origin = { taskId: task.taskId, memberName: 'worker' };
  const shown = await review.invoke({ method: 'getFileContent', args: [BOUND_REVIEW_TEAM, 'worker', f.file, []] }, origin);
  if (shown.method !== 'getFileContent') throw new Error('Wrong content projection');
  assert.equal(shown.result.originalFullContent, 'TEST initially dirty\n');
  assert.equal(shown.result.modifiedFullContent, request.toolInput.content);
  const watched = await review.authorizeWatch({ projectPath: later, filePaths: [f.file], scope: origin });
  assert.equal(watched.projectPath, f.workspace);
  assert.equal(readFileSync(ledger, 'utf8'), originalBytes, 'review never rewrites historical actor/input/fingerprint');
  const view = await review.getTaskChanges(task.taskId);
  assert.equal(view.scope?.memberName, 'worker');
  assert.equal(view.files[0]!.snippets[0]!.ledger!.actorId, 'worker-id');
});
