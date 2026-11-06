import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentChangeLedgerReader } from '@agent-teams/task-change-ledger';
import { BOUND_REVIEW_TEAM } from '@agent-teams/task-change-ledger/review-transport';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { createHostTeamReview } from '../dist/composition/HostTeamReview.js';
import { createClaudeToolEvidenceCapture } from '../dist/evidence/ClaudeToolEvidenceWriter.js';
import { ToolEvidenceWindows } from '../dist/evidence/ToolEvidenceWindows.js';
import { evidenceProjectDir } from '../dist/evidence/evidenceProjectDir.js';
import { digest } from '../dist/team/identity.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import type { TestContext } from 'node:test';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';
import type { RuntimeMemberProfile } from '../dist/composition/runtimeProfile.js';
import type { ClaudeCaptureRequest } from '@agent-teams/provider-implementations/claude';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';

async function fixture(t: TestContext, task = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-agent-evidence-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const file = join(workspace, 'value.txt');
  writeFileSync(file, 'TEST dirty before\n');
  execFileSync('git', ['-c', 'core.fsmonitor=false', 'init', '-q'], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  execFileSync('git', ['-c', 'core.fsmonitor=false', 'add', 'value.txt'], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    teamName: 'test-agent',
  };
  const members = ['lead', 'alice'].map((name) => ({
    name,
    memberId: `${name}-id`,
    role: name === 'lead' ? ('lead' as const) : ('member' as const),
    delivery: {
      ...binding,
      runId: 'TEST-run',
      memberId: `${name}-id`,
      generation: '1',
    },
  }));
  const grants = [
    {
      principalId: 'human',
      memberName: 'user',
      permissions: ['read', 'admin', 'task.write', 'message.write'] as const,
    },
    {
      principalId: 'alice-principal',
      memberName: 'alice',
      permissions: ['read', 'task.write', 'message.write'] as const,
    },
  ].map((value) => ({ ...value, permissions: [...value.permissions] }));
  const ownerOptions = {
    root: join(root, 'storage'),
    binding,
    members,
    grants,
  };
  const owner = createFilesystemTeamOwner(ownerOptions),
    human = owner.connect('human');
  let taskId: string | undefined;
  if (task) {
    taskId = human.execute({
      commandId: 'TEST-create',
      operation: 'task.create',
      payload: { subject: 'TEST', owner: 'alice' },
    }).effects.taskId;
    human.execute({
      commandId: 'TEST-input',
      operation: 'task.start',
      payload: { taskId, notification: 'user' },
    });
  } else
    human.execute({
      commandId: 'TEST-input',
      operation: 'message.send',
      payload: {
        to: 'alice',
        text: 'TEST generic edit',
        messageId: 'TEST-input',
      },
    });
  const intent = human.pendingDeliveries().find((row) => row.commandId === 'TEST-input')!;
  assert.ok(intent);
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
    hostIncarnation: 'TEST-host',
    config,
    workspace: {
      path: workspace,
      identity: digest({ dev: info.dev, ino: info.ino }),
    },
  };
  const runtimeStore = new FileRuntimeStore(ownerOptions.root);
  let closed = false,
    wake: (() => void) | undefined;
  const events: Event[] = [];
  let submitted: Input | undefined;
  const driver: Session = {
    sessionRef: 'TEST-native',
    async submit(input) {
      submitted = input;
      return {
        ok: true,
        value: {
          inputId: input.inputId,
          operationRef: input.operationRef,
          delivery: 'client-consumed',
          providerAcceptance: 'unknown',
        },
      };
    },
    observe: async function* () {
      while (!closed || events.length) {
        const event = events.shift();
        if (event) yield event;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    },
    respondToInteraction: async () => ({ ok: false, code: 'unsupported' }),
    interrupt: async () => ({ ok: false, code: 'unsupported' }),
    checkpoint: () => ({ ok: false, code: 'unsupported' }),
    checkReadiness: async () => ({ ok: true, value: undefined }),
    async close() {
      closed = true;
      wake?.();
      return { logicallyClosed: true, cleanup: 'confirmed' };
    },
  };
  const runtime = new RuntimeOwner({
    store: runtimeStore,
    profileId: captured.profileId,
    hostIncarnation: captured.hostIncarnation,
    driverFactory: {
      open: async () => ({ driver, capabilities: config.requiredCapabilities }),
    },
    authorize: (binding, action, delivery) =>
      delivery
        ? owner.authorizeDeliveryIntent(delivery, action)
        : owner.authorizeRuntimeAccess('human', binding, action === 'read' ? 'read' : 'control'),
    canDispatch: (_, delivery) => owner.authorizeDeliveryIntent(delivery, 'dispatch'),
  });
  t.after(async () => {
    await runtime.stopCapturedSession(intent.binding);
    rmSync(root, { recursive: true, force: true });
  });
  await runtime.openSession({ binding: intent.binding, config });
  assert.equal((await runtime.admitDelivery(intent)).outcome, 'admitted');
  const consumed = await runtime.dispatchNext(intent.binding);
  assert.equal(consumed.inputs[0]!.phase, 'consumed');
  assert.ok(submitted);
  assert.equal(submitted.inputId, intent.inputId);
  const runtimeProfile: RuntimeMemberProfile = {
    provider: 'claude',
    teamId: binding.teamId,
    memberId: 'alice-id',
    principalId: 'alice-principal',
    sessionId: config.sessionId,
    generation: config.generation,
    configRevision: config.configRevision,
    model: 'TEST-model',
    accountBinding: 'TEST-account',
    cwd: workspace,
    executable: { path: '/TEST/no-native-process', sha256: 'a'.repeat(64) },
    environment: { HOME: root, CLAUDE_CONFIG_DIR: root, PATH: '/TEST/bin' },
    nativeTools: ['Write'],
    autoAllowedTools: [],
    limits: {
      queuedInputs: 8,
      inputBytes: 65536,
      outputBytes: 65536,
      outputEvents: 256,
      pendingInteractions: 8,
      timeoutMs: 1000,
    },
  };
  const request: Extract<ClaudeCaptureRequest, { phase: 'before' }> = {
    phase: 'before',
    sessionRef: 'TEST-native',
    inputId: intent.inputId,
    operationRef: submitted.operationRef,
    toolUseId: 'TEST-tool',
    toolName: 'Write',
    toolInput: {
      file_path: file,
      content: task ? 'TEST task final\n' : 'TEST final\n',
    },
    signal: new AbortController().signal,
  };
  const projectDir = evidenceProjectDir(ownerOptions.root, binding.teamName);
  const capture = createClaudeToolEvidenceCapture({
    captured,
    ledgerProjectDir: projectDir,
    windows: new ToolEvidenceWindows(),
    readRuntime: () => runtime.readCapturedSession(intent.binding),
    lookupTaskCause: (input) => owner.lookupTaskStartCause('human', input),
    lookupInputCause: (input) => owner.lookupToolInputCause('human', input),
    assertCurrent() {},
    withWriteFence: (action) => owner.withLaunchAuthority('human', 'read', action),
  });
  const finish = async () => {
    await capture.observe({ ...request, phase: 'after', outcome: 'succeeded' });
    await capture.observeBatch!({
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
  };
  const reader = () =>
    new AgentChangeLedgerReader().readAgentChanges({
      teamName: binding.teamName,
      memberName: 'alice',
      actorId: 'alice-id',
      projectDir,
      projectPath: workspace,
    });
  const reopenService = () => {
    const cold = createFilesystemTeamOwner(ownerOptions);
    const team: HostedTeam = {
      owner: cold,
      connection: cold.connect('human'),
      definition: {
        binding,
        members,
        grants,
        scope: {
          projectId: 'TEST-project',
          workspaceId: 'TEST-workspace',
          teamId: binding.teamId,
          runId: 'TEST-run',
          memberId: 'human',
          generation: '1',
        },
      },
    };
    const service = createHostTeamReview({
      team,
      assertCurrent() {},
      principalId: 'human',
      ownerStorageRoot: ownerOptions.root,
      initialRuntimeMembers: [runtimeProfile],
      projectPath: workspace,
      processStartProbe: async () => null,
    });
    t.after(() => service.dispose());
    return service;
  };
  return {
    root,
    owner,
    human,
    file,
    request,
    runtime,
    stop: () => runtime.stopCapturedSession(intent.binding),
    capture,
    finish,
    reader,
    reopenService,
    taskId,
    projectDir,
    events: join(projectDir, '.board-task-changes', 'agents', 'alice-id', 'events.jsonl'),
  };
}

test('generic persisted message input captures into an agent artifact and cold Host agent content reads original bytes', async (t) => {
  const f = await fixture(t);
  await f.capture.observe(f.request);
  writeFileSync(f.file, 'TEST final\n');
  await f.finish();
  const raw = JSON.parse(readFileSync(f.events, 'utf8').trim());
  assert.equal(raw.artifactKind, 'agent-input');
  assert.equal('taskId' in raw, false);
  assert.equal(raw.causalBinding.messageCommandId, 'TEST-input');
  assert.equal(raw.executionSeq, 0);
  const service = f.reopenService(),
    view = await service.getAgentChanges('alice');
  assert.equal(view.totalFiles, 1);
  assert.equal(view.actorId, 'alice-id');
  assert.equal(view.files[0]!.snippets[0]!.ledger!.actorId, 'alice-id');
  assert.equal(view.files[0]!.snippets[0]!.ledger!.inputId, f.request.inputId);
  assert.equal(view.diffStatCompleteness, 'partial');
  assert.ok(view.warnings!.some((w) => w.includes('unqualified')));
  const content = await service.invoke(
    {
      method: 'getFileContent',
      args: [BOUND_REVIEW_TEAM, 'alice', f.file, []],
    },
    { memberName: 'alice' }
  );
  assert.equal(content.method, 'getFileContent');
  if (content.method === 'getFileContent') {
    assert.equal(content.result.originalFullContent, 'TEST dirty before\n');
    assert.equal(content.result.modifiedFullContent, 'TEST final\n');
  }
  const again = await f.reader();
  assert.deepEqual(again.files, view.files);
  await f.finish();
  assert.equal(readFileSync(f.events, 'utf8').split('\n').filter(Boolean).length, 1);
  rmSync(join(f.projectDir, '.board-task-changes', 'blobs', raw.after.blobRef));
  await assert.rejects(service.getChangeStats('alice'), /statistics are unavailable/);
  assert.equal((await service.getAgentChanges('alice')).files[0]!.diffStatKnown, false);
});

test('Task reassignment does not transfer immutable event actor to the current assignee', async (t) => {
  const f = await fixture(t, true);
  await f.capture.observe(f.request);
  writeFileSync(f.file, 'TEST task final\n');
  await f.finish();
  f.human.execute({
    commandId: 'TEST-reassign',
    operation: 'task.assign',
    payload: { taskId: f.taskId!, owner: 'lead' },
  });
  const service = f.reopenService();
  assert.equal((await service.getAgentChanges('alice')).totalFiles, 1);
  assert.equal((await service.getAgentChanges('lead')).totalFiles, 0);
  await assert.rejects(service.getChangeStats('lead'), /statistics are unavailable/);
  assert.equal((await service.getChangeStats('alice')).completeness, 'partial');
  assert.equal(
    (await service.getAgentChanges('alice')).files[0]!.snippets[0]!.ledger!.taskId,
    f.taskId
  );
});

test('revoked or retired generic input cannot settle or retarget an already opened capture', async (t) => {
  for (const reason of ['revoke', 'retire'] as const) {
    const f = await fixture(t);
    await f.capture.observe(f.request);
    writeFileSync(f.file, 'TEST late\n');
    if (reason === 'revoke') f.human.revoke('alice-principal');
    else await f.stop();
    await f.finish();
    assert.equal(existsSync(f.events), false);
  }
});

test('agent journal symlink is rejected and bounded oversized artifact cannot become an empty complete result', async (t) => {
  const f = await fixture(t);
  await f.capture.observe(f.request);
  writeFileSync(f.file, 'TEST final\n');
  await f.finish();
  const saved = readFileSync(f.events);
  rmSync(f.events);
  const other = join(f.root, 'other.jsonl');
  writeFileSync(other, saved);
  symlinkSync(other, f.events);
  const unsafe = await f.reader();
  assert.equal(unsafe.totalFiles, 0);
  assert.equal(unsafe.provenance!.integrity, 'partial');
  assert.ok(unsafe.warnings!.some((w) => w.includes('unsafe')));
  rmSync(f.events);
  writeFileSync(f.events, saved);
  truncateSync(f.events, 33 * 1024 * 1024);
  await assert.rejects(f.reader(), /budget/);
});

test('inventory budget counts ignored directory entries instead of traversing them without a bound', async (t) => {
  const f = await fixture(t);
  const directory = join(f.projectDir, '.board-task-changes', 'events');
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 513; index++) writeFileSync(join(directory, `ignored-${index}`), '');
  await assert.rejects(f.reader(), /inventory capped/);
});

test('ordinary Agent invocation records a qualified input gap without attributing child files to its parent tool', async t => {
  const f = await fixture(t);
  const request = { ...f.request, toolName: 'Agent', toolInput: { prompt: 'TEST child', description: 'TEST', subagent_type: 'host-ordinary', run_in_background: false } };
  await f.capture.observe(request);
  assert.deepEqual(f.capture.readStatus(), { phase: 'gap', reason: 'unsupported-tool' });
  assert.equal(existsSync(f.events), false, 'the parent Agent is not a child native file effect proof');
  const notices = join(f.projectDir, '.board-task-changes', 'agents', 'alice-id', 'notices.jsonl');
  const rows = readFileSync(notices, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  assert.ok(rows.some(row => typeof row.message === 'string' && row.message.includes('parent Agent call does not prove child changes')));
  assert.equal(readFileSync(f.file, 'utf8'), 'TEST dirty before\n');
});
