import { initialContextDigest } from '../dist/team-launch/context.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { ClaudeManagementCoordinator } from '../dist/composition/ClaudeManagementCoordinator.js';
import { teamModelProbeProfile } from '../dist/composition/teamLaunchModelProbe.js';

import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type {
  MemberProvider,
  MemberProviderContext,
} from '../dist/adapters/providers/MemberProvider.js';
import type { CommandReceipt } from '../dist/team/contracts.js';
import type { TeamRosterConfiguration } from '../dist/team/rosterContracts.js';
import type { RuntimeBinding } from '../dist/runtime/contracts.js';
import type {
  CloseReceipt,
  DriverFactory,
  Event,
  Input,
  Session,
} from '@agent-teams/provider-session-contracts';
import type { TestContext } from 'node:test';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
test('task recovery never returns a prior receipt for a changed command with unavailable attachments', async t => {
  const f = await fixture(t);
  const original = { operation: 'task.create', payload: { subject: 'TEST exact retained command' } };
  const created = await f.rpc('team.execute', original, { commandId: 'TEST-retained-create' }) as { ok: boolean; value: CommandReceipt };
  assert.equal(created.ok, true); assert.equal(created.value.phase, 'completed');
  assert.deepEqual(await f.rpc('team.execute', original, { commandId: 'TEST-retained-create' }), created);
  const taskId = created.value.effects.taskId;
  const comment = { operation: 'task.comment', payload: { taskId, text: 'TEST original comment' } };
  const commented = await f.rpc('team.execute', comment, { commandId: 'TEST-retained-comment' }) as { ok: boolean; value: CommandReceipt };
  assert.equal(commented.ok, true); assert.equal(commented.value.phase, 'completed');
  const before = await f.rpc('team.task.get', { taskId });
  const attachment = { artifactId: 'TEST-unavailable-artifact', mimeType: 'text/plain', byteLength: 1, digest: 'd'.repeat(64) };
  for (const commandId of ['TEST-retained-create', 'TEST-retained-comment']) {
    const changed = await f.rpc('team.execute', { operation: 'task.comment',
      payload: { taskId, text: 'TEST changed request must never borrow success', attachments: [attachment] } }, { commandId });
    assert.deepEqual(changed, { ok: false, code: 'conflict', outcome: 'rejected' });
    assert.deepEqual(await f.rpc('team.task.get', { taskId }), before);
  }
  assert.deepEqual(await f.rpc('team.execute', original, { commandId: 'TEST-retained-create' }), created);
  assert.deepEqual(await f.rpc('team.execute', comment, { commandId: 'TEST-retained-comment' }), commented);
  assert.equal(f.opens(), 0); assert.equal(f.contexts.length, 0, 'recovery cannot allocate a provider');
  const tasks = await f.rpc('team.tasks.list', {}) as { ok: boolean; value: unknown[] };
  assert.equal(tasks.ok, true); assert.equal(tasks.value.length, 1);
});

test('two captured teams may share an original run ID without sharing launch ownership', async (t) => {
  const f = await fixture(t, {
    changeProfile(profile) {
      const first = profile.teams[0]!,
        second = structuredClone(first);
      second.binding.teamId = 'TEST-second-team';
      second.binding.teamName = 'test-second-team';
      second.scope.teamId = second.binding.teamId;
      for (const member of second.members)
        if (member.delivery) Object.assign(member.delivery, second.binding);
      profile.teams.push(second);
      const native = structuredClone(profile.runtime!.members[0]!);
      native.teamId = second.binding.teamId;
      native.sessionId = 'TEST-second-session';
      profile.runtime!.members.push(native);
    },
  });
  const binding = { ...f.binding, scope: f.selected.teams[1]!.scope };
  const second = await f.rpc('team.launch.read', {}, { binding });
  assert.equal((second as { ok: boolean }).ok, true, JSON.stringify(second));
  assert.equal(
    ((await f.rpc('runtime.open', { memberId: 'alice-id' }, { binding })) as { ok: boolean }).ok,
    true
  );
  assert.equal(f.opens(), 1);
  assert.equal(f.contexts[0]!.profile.teamId, 'TEST-second-team');
});

test('a superseded unstarted capture cannot inject its prompt into a newer launch with the same product revision', async (t) => {
  const f = await fixture(t, {
    changeProfile(profile) {
      profile.teams[0]!.members = profile.teams[0]!.members.slice(0, 1);
      profile.teams[0]!.members[0]!.role = 'lead';
      profile.teams[0]!.members[0]!.settings = { cwd: '/TEST/WRONG-lead-cwd' };
    },
  });
  const roster = (await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration };
  await f.rpc(
    'team.roster.replace',
    {
      expectedRevision: roster.value.revision,
      members: [],
      savedSettings: { cwd: f.root, prompt: 'TEST prompt must stay on its original launch' },
    },
    { commandId: 'TEST-same-source' }
  );
  const source = { rosterCommandId: 'TEST-same-source' };
  const first = (await f.rpc('team.launch.capture', source, { commandId: 'TEST-capture-A' })) as {
    ok: boolean;
    value: {
      launch: { launchId: string; rosterRevision: string };
      members: { selected: { workspace: string } }[];
    };
  };
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(
    first.value.members[0]!.selected.workspace,
    f.root,
    'global lead cwd overrides stale member cwd'
  );
  const second = await f.rpc('team.launch.capture', source, { commandId: 'TEST-capture-B' });
  assert.equal((second as { ok: boolean }).ok, true, JSON.stringify(second));
  assert.deepEqual(
    await f.rpc(
      'team.launch.start',
      { launchId: first.value.launch.launchId, rosterRevision: first.value.launch.rosterRevision },
      { commandId: 'TEST-stale-start' }
    ),
    { ok: false, code: 'hold', outcome: 'unknown' }
  );
  const snapshot = (await f.rpc('team.snapshot', {})) as { value: { messages: unknown[] } };
  assert.equal(snapshot.value.messages.length, 0);
  assert.equal(f.opens(), 0);
});

test('saved configuration captures fresh native identities, preserves historical launches and replays after cold restart', async (t) => {
  const f = await fixture(t, {
    changeProfile(profile) {
      profile.teams[0]!.members = profile.teams[0]!.members.slice(0, 1);
      profile.teams[0]!.members[0]!.role = 'lead';
    },
  });
  const original = (await f.rpc('team.launch.read', {})) as {
    value: { launchId: string; rosterRevision: string };
  };
  const before = (await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration };
  const source = {
    expectedRevision: before.value.revision,
    members: [],
    savedSettings: {
      cwd: f.root,
      providerId: 'anthropic',
      model: 'TEST-captured-model',
      effort: 'medium',
      fastMode: 'off',
      skipPermissions: false,
      limitContext: true,
      prompt: 'TEST launch prompt',
    },
  };
  assert.equal(
    (
      (await f.rpc('team.roster.replace', source, { commandId: 'TEST-source-roster' })) as {
        ok: boolean;
      }
    ).ok,
    true
  );
  const input = { rosterCommandId: 'TEST-source-roster' };
  const capture = (await f.rpc('team.launch.capture', input, {
    commandId: 'TEST-capture-original',
  })) as {
    ok: boolean;
    value: {
      launch: { launchId: string; rosterRevision: string; members: { binding: RuntimeBinding }[] };
      members: { selected: { model: string; effort: string; workspace: string } }[];
    };
  };
  assert.equal(capture.ok, true, JSON.stringify(capture));
  assert.notEqual(capture.value.launch.launchId, original.value.launchId);
  assert.equal(capture.value.members[0]!.selected.model, 'TEST-captured-model');
  assert.equal(capture.value.members[0]!.selected.effort, 'medium');
  assert.equal(capture.value.members[0]!.selected.workspace, f.root);
  assert.equal(f.opens(), 0, 'capturing configuration cannot allocate native resources');
  assert.equal(
    ((await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration }).value.revision,
    (
      (await f.rpc('team.roster.lookup', {}, { commandId: 'TEST-source-roster' })) as {
        value: { revision: string };
      }
    ).value.revision
  );
  assert.equal(
    (
      (await f.rpc('team.launch.capture', input, {
        commandId: 'TEST-capture-original',
      })) as typeof capture
    ).value.launch.launchId,
    capture.value.launch.launchId
  );
  const start = {
    launchId: capture.value.launch.launchId,
    rosterRevision: capture.value.launch.rosterRevision,
  };
  assert.equal(
    (
      (await f.rpc('team.launch.start', start, { commandId: 'TEST-start-original' })) as {
        ok: boolean;
      }
    ).ok,
    true
  );
  await eventually(
    () => f.opens() === 1 && f.contexts[0]!.isCurrent(),
    'new captured provider must open'
  );
  const context = f.contexts[0]!;
  await eventually(
    () => f.session().submits.length === 1,
    'saved launch prompt must dispatch through Team/Runtime'
  );
  assert.equal(f.session().submits[0]!.content, 'TEST launch prompt');
  assert.equal(
    (
      (await f.rpc('team.launch.start', start, { commandId: 'TEST-start-original' })) as {
        ok: boolean;
      }
    ).ok,
    true
  );
  assert.equal(
    f.session().submits.length,
    1,
    'original start replay cannot duplicate the launch prompt'
  );
  f.session().finish(0);
  await eventually(
    () =>
      new FileRuntimeStore(f.root).fenced(
        context.endpoint.binding,
        (tx) => tx.get()?.inputs[0]?.phase === 'terminal'
      ),
    'launch prompt result must persist'
  );
  assert.equal(context.profile.model, 'TEST-captured-model');
  assert.notEqual(context.profile.sessionId, f.selected.runtime!.members[0]!.sessionId);
  assert.notEqual(context.profile.principalId, 'alice-session');
  assert.notEqual(context.endpoint.binding.generation, '1');
  assert.equal(context.profile.accountBinding, f.selected.runtime!.members[0]!.accountBinding);
  assert.equal(context.profile.provider, 'claude');
  if (context.profile.provider === 'claude') {
    assert.equal(context.profile.nativeOptions!.effort, 'medium');
    assert.equal(context.profile.nativeOptions!.permissionMode, 'default');
    assert.equal(context.profile.nativeOptions!.fastMode, false);
  }
  // A second capture while this exact native session is live must hold without switching selection.
  const denied = await f.rpc('team.launch.capture', input, { commandId: 'TEST-second-capture' });
  assert.deepEqual(denied, { ok: false, code: 'hold', outcome: 'unknown' });
  assert.equal(
    ((await f.rpc('team.launch.read', {})) as { value: { launchId: string } }).value.launchId,
    start.launchId
  );
  await f.rpc('runtime.stop', {
    memberId: 'alice-id',
    expectedGeneration: context.endpoint.binding.generation,
  });
  const next = (await f.rpc('team.launch.capture', input, {
    commandId: 'TEST-second-capture',
  })) as typeof capture;
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.notEqual(next.value.launch.launchId, start.launchId);
  assert.equal(context.isCurrent(), false, 'new grants cannot revive the original member context');
  assert.equal(
    (
      (await f.rpc('team.launch.read', { launchId: start.launchId })) as {
        value: { launchId: string };
      }
    ).value.launchId,
    start.launchId
  );
  await f.restart();
  assert.equal(f.opens(), 1, 'cold reconstruction does not allocate a provider');
  const replay = (await f.rpc('team.launch.capture', input, {
    commandId: 'TEST-second-capture',
  })) as typeof capture;
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.value.launch.launchId, next.value.launch.launchId);
  assert.equal(
    (
      (await f.rpc('team.launch.read', { launchId: start.launchId })) as {
        value: { launchId: string };
      }
    ).value.launchId,
    start.launchId
  );
  assert.equal(
    (
      (await f.rpc(
        'team.launch.capture',
        { rosterCommandId: 'TEST-other-roster' },
        { commandId: 'TEST-second-capture' }
      )) as { code: string }
    ).code,
    'conflict'
  );
  assert.equal(f.opens(), 1);
});

test('capture rejects stale product sources, missing recipes and protected args before native allocation', async (t) => {
  const f = await fixture(t, {
    changeProfile(profile) {
      profile.teams[0]!.members[0]!.role = 'lead';
    },
  });
  const before = (await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration };
  const source = {
    expectedRevision: before.value.revision,
    members: [{ name: 'bob' }],
    savedSettings: { cwd: f.root },
  };
  await f.rpc('team.roster.replace', source, { commandId: 'TEST-missing-recipe-source' });
  assert.deepEqual(
    await f.rpc(
      'team.launch.capture',
      { rosterCommandId: 'TEST-missing-recipe-source' },
      { commandId: 'TEST-no-recipe' }
    ),
    { ok: false, code: 'invalid', outcome: 'rejected', reason: 'runtime-recipe-unconfigured' }
  );
  const current = (await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration };
  await f.rpc(
    'team.roster.replace',
    {
      expectedRevision: current.value.revision,
      members: [],
      savedSettings: { cwd: f.root, extraCliArgs: '--mcp-config=/TEST/foreign' },
    },
    { commandId: 'TEST-next-source' }
  );
  assert.deepEqual(
    await f.rpc(
      'team.launch.capture',
      { rosterCommandId: 'TEST-missing-recipe-source' },
      { commandId: 'TEST-stale-source' }
    ),
    { ok: false, code: 'conflict', outcome: 'rejected', reason: 'capture-source-revision' }
  );
  assert.deepEqual(
    await f.rpc(
      'team.launch.capture',
      { rosterCommandId: 'TEST-next-source' },
      { commandId: 'TEST-unsupported' }
    ),
    {
      ok: false,
      code: 'invalid',
      outcome: 'rejected',
      reason: 'runtime-extra-args-invalid',
    }
  );
  assert.deepEqual(await f.rpc('team.launch.read', {}), { ok: true, value: null });
  assert.equal(f.opens(), 0);
});

test('NDJSON saved roster edits preserve product APIs across stale runtime capture/restart without allocation', async (t) => {
  const f = await fixture(t, {
    changeProfile: (profile) => {
      profile.teams[0]!.members[0]!.role = 'lead';
    },
  });
  const initial = (await f.rpc('team.roster.read', {})) as {
    ok: boolean;
    value: TeamRosterConfiguration;
  };
  assert.equal(initial.ok, true);
  const payload = {
    expectedRevision: initial.value.revision,
    members: [
      { name: 'bob', workflow: 'TEST roster instructions', providerId: 'codex', fastMode: 'off' },
      { name: 'new-worker' },
    ],
  };
  const receipt = await f.rpc('team.roster.replace', payload, { commandId: 'TEST-roster-publish' });
  assert.equal((receipt as { ok: boolean }).ok, true);
  assert.deepEqual(
    await f.rpc('team.roster.lookup', {}, { commandId: 'TEST-roster-publish' }),
    receipt
  );
  assert.deepEqual(
    await f.rpc('team.roster.replace', payload, { commandId: 'TEST-roster-publish' }),
    receipt
  );
  const saved = (await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration };
  assert.deepEqual(
    saved.value.members.map((member) => member.name),
    ['alice', 'bob', 'new-worker']
  );
  assert.equal(saved.value.members[1]!.settings.fastMode, 'off');
  const snapshot = (await f.rpc('team.snapshot', {})) as { value: { members: { name: string }[] } };
  assert.deepEqual(
    snapshot.value.members.map((member) => member.name),
    ['alice', 'bob', 'new-worker']
  );
  assert.equal(
    ((await f.rpc('runtime.open', { memberId: 'alice-id' })) as { ok: boolean }).ok,
    false,
    'old native capture cannot launch changed product settings'
  );
  assert.equal(f.opens(), 0);
  assert.deepEqual(
    await f.rpc('team.launch.read', {}),
    { ok: true, value: null },
    'warm current selection never exposes detached old targets'
  );
  assert.deepEqual(await f.rpc('team.launch.configuration.read', {}), { ok: true, value: null });
  await f.restart();
  assert.deepEqual(await f.rpc('team.roster.read', {}), saved);
  assert.deepEqual(await f.rpc('team.launch.configuration.read', {}), { ok: true, value: null });
  const task = await f.rpc(
    'team.execute',
    { operation: 'task.create', payload: { subject: 'Saved team remains editable', owner: 'bob' } },
    { commandId: 'TEST-roster-task' }
  );
  assert.equal((task as { ok: boolean }).ok, true);
  const next = (await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration };
  assert.equal(
    (
      (await f.rpc(
        'team.roster.replace',
        { expectedRevision: next.value.revision, members: [{ name: 'bob' }] },
        { commandId: 'TEST-roster-after-restart' }
      )) as { ok: boolean }
    ).ok,
    true
  );
  assert.equal(f.opens(), 0);
});

test('NDJSON roster replacement refuses live allocation, then saves only after confirmed stop', async (t) => {
  const f = await fixture(t, {
    changeProfile: (profile) => {
      profile.teams[0]!.members[0]!.role = 'lead';
    },
  });
  const initial = (await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration };
  assert.equal(
    ((await f.rpc('runtime.open', { memberId: 'alice-id' })) as { ok: boolean }).ok,
    true
  );
  const payload = {
    expectedRevision: initial.value.revision,
    members: [{ name: 'bob', model: 'TEST-new-model' }],
  };
  assert.deepEqual(await f.rpc('team.roster.replace', payload, { commandId: 'TEST-live-edit' }), {
    ok: false,
    code: 'hold',
    outcome: 'unknown',
  });
  assert.deepEqual(await f.rpc('team.roster.read', {}), { ok: true, value: initial.value });
  assert.deepEqual(await f.rpc('team.roster.lookup', {}, { commandId: 'TEST-live-edit' }), {
    ok: true,
    value: null,
  });
  const sent = (await f.rpc(
    'team.execute',
    {
      operation: 'message.send',
      payload: { to: 'alice', text: 'TEST complete before settings edit' },
    },
    { commandId: 'TEST-roster-prior-message' }
  )) as { value: CommandReceipt };
  await eventually(
    () => f.session().submits.length === 1,
    'original input reaches the controlled provider'
  );
  const input = f.session().submits[0]!;
  f.session().emit({
    kind: 'result',
    sessionRef: f.session().sessionRef,
    inputId: input.inputId,
    operationRef: input.operationRef,
    outcome: 'succeeded',
  });
  const runtimeStore = new FileRuntimeStore(f.root);
  await eventually(
    () => runtimeStore.fenced(f.runtimeBinding, (tx) => tx.get()?.inputs[0]?.phase === 'terminal'),
    'Runtime owns the terminal fact'
  );
  const cached = JSON.parse(
    readFileSync(
      join(
        f.root,
        'teams',
        f.selected.teams[0]!.binding.teamName,
        '.host-owner',
        'outbox',
        sent.value.effects.deliveryId + '.json'
      ),
      'utf8'
    )
  ) as { phase: string; runtimeReceipt: { phase: string } };
  assert.equal(cached.phase, 'admitted');
  assert.equal(
    cached.runtimeReceipt.phase,
    'admitted',
    'immutable admission is not a live input status cache'
  );
  await f.rpc('runtime.stop', { memberId: 'alice-id' });
  assert.equal(
    (
      (await f.rpc('team.roster.replace', payload, { commandId: 'TEST-live-edit' })) as {
        ok: boolean;
      }
    ).ok,
    true
  );
  assert.equal(f.opens(), 1);
  await f.restart();
  assert.equal(
    ((await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration }).value.members[1]!
      .settings.model,
    'TEST-new-model'
  );
  assert.equal(f.opens(), 1);
});

test('NDJSON unknown native cleanup keeps the saved roster and its original grants bound', async (t) => {
  const f = await fixture(t, {
    unknownCleanup: true,
    changeProfile: (profile) => {
      profile.teams[0]!.members[0]!.role = 'lead';
    },
  });
  const initial = (await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration };
  await f.rpc('runtime.open', { memberId: 'alice-id' });
  await f.rpc('runtime.stop', { memberId: 'alice-id' });
  const payload = {
    expectedRevision: initial.value.revision,
    members: [{ name: 'bob', workflow: 'TEST new settings' }],
  };
  assert.deepEqual(
    await f.rpc('team.roster.replace', payload, { commandId: 'TEST-unknown-custody' }),
    { ok: false, code: 'hold', outcome: 'unknown' }
  );
  assert.deepEqual(await f.rpc('team.roster.read', {}), { ok: true, value: initial.value });
  assert.deepEqual(await f.rpc('team.roster.lookup', {}, { commandId: 'TEST-unknown-custody' }), {
    ok: true,
    value: null,
  });
  assert.equal(f.opens(), 1);
});
function assertSameLaunch(actual: unknown, expected: unknown, message?: string): void {
  const next = actual as { ok: boolean; value: { observedAtMs: number } };
  const previous = expected as typeof next;
  assert.equal(typeof next.value.observedAtMs, 'number');
  assert.ok(next.value.observedAtMs >= previous.value.observedAtMs);
  // The Host made a fresh observation; every identity/state field must remain exact.
  assert.deepEqual(
    { ...next, value: { ...next.value, observedAtMs: previous.value.observedAtMs } },
    previous,
    message
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function eventually(check: () => boolean, message: string): Promise<void> {
  for (let count = 0; count < 200; count++) {
    if (check()) return;
    await tick();
  }
  assert.fail(message);
}

/** Controlled native boundary only: Team, Runtime, HTTP MCP and NDJSON are real. */
class ControlledSession implements Session {
  readonly sessionRef = 'PRIVATE-native-session';
  readonly submits: Input[] = [];
  closeCalls = 0;
  cleanup: CloseReceipt['cleanup'] = 'confirmed';
  private readonly events: Event[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  private readonly progress: () => void;
  constructor(progress: () => void) {
    this.progress = progress;
  }
  submit: Session['submit'] = async (input) => {
    this.submits.push(input);
    return {
      ok: true,
      value: {
        inputId: input.inputId,
        operationRef: input.operationRef,
        delivery: 'client-consumed',
        providerAcceptance: 'unknown',
      },
    };
  };
  observe = async function* (this: ControlledSession): AsyncIterable<Event> {
    while (!this.ended || this.events.length) {
      const event = this.events.shift();
      if (event) {
        yield event;
        // Like the real provider wrapper, notify only after Runtime persisted the event.
        this.progress();
      } else
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
    }
  };
  respondToInteraction: Session['respondToInteraction'] = async () => ({
    ok: true,
    value: undefined,
  });
  interrupt: Session['interrupt'] = async () => ({
    ok: true,
    value: { requested: true, terminal: 'unconfirmed' },
  });
  checkReadiness: Session['checkReadiness'] = async () => ({ ok: true, value: undefined });
  checkpoint: Session['checkpoint'] = () => ({ ok: false, code: 'unsupported' });
  close: Session['close'] = async () => {
    this.closeCalls++;
    this.ended = true;
    this.waiter?.();
    return { logicallyClosed: true, cleanup: this.cleanup };
  };
  emit(event: Event): void {
    this.events.push(event);
    this.waiter?.();
    this.waiter = undefined;
  }
  finish(index: number): void {
    const input = this.submits[index];
    assert.ok(input);
    this.emit({
      kind: 'result',
      sessionRef: this.sessionRef,
      inputId: input.inputId,
      operationRef: input.operationRef,
      outcome: 'succeeded',
    });
  }
}

function profile(root: string): TeamHostProfile {
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-runtime-host' };
  return {
    schemaVersion: 1,
    owner: {
      ownerId: binding.backendId,
      revision: 'revision-1',
      storageRoot: root,
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-runtime-team-host',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    principalId: 'human',
    teams: [
      {
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
            memberId: 'alice-id',
            name: 'alice',
            role: 'member',
            delivery: { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' },
          },
          { memberId: 'bob-id', name: 'bob', role: 'member' },
        ],
        grants: [
          {
            principalId: 'human',
            memberName: 'user',
            permissions: ['read', 'task.write', 'message.write', 'admin'],
          },
          {
            principalId: 'alice-session',
            memberName: 'alice',
            permissions: ['read', 'task.write', 'message.write'],
          },
        ],
      },
    ],
    runtime: {
      members: [
        {
          teamId: binding.teamId,
          memberId: 'alice-id',
          principalId: 'alice-session',
          provider: 'claude',
          sessionId: 'PRIVATE-config-session',
          generation: 1,
          configRevision: 'PRIVATE-config-revision',
          cwd: root,
          model: 'PRIVATE-model',
          accountBinding: 'PRIVATE-account',
          environment: { HOME: root, PATH: '/TEST/no-native-execution', CLAUDE_CONFIG_DIR: root, TEST_TOKEN: 'PRIVATE-environment-token' },
          executable: { path: '/TEST/nonexistent-no-execution', sha256: 'c'.repeat(64) },
          nativeTools: [],
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
}

interface ActivityPage {
  memberId: string;
  cursor: string;
  retainedFrom: number;
  events: { sequence: number; data: Record<string, unknown>; inputId?: string }[];
  hasMore: boolean;
  gap?: { reason: string };
  state?: unknown;
  latest?: { text: unknown[]; tools: unknown[]; usage: unknown[]; interactions: unknown[] };
}

async function fixture(
  t: TestContext,
  options: {
    changeProfile?(selected: TeamHostProfile): void;
    open?: Promise<Awaited<ReturnType<DriverFactory['open']>>>;
    unknownCleanup?: boolean;
    checkpointHistory?: boolean;
    onProvider?(context: MemberProviderContext): void;
    onCleanup?(): void;
    disposeTimeoutMs?: number;
  } = {}
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-runtime-team-host-')));
  const selected = profile(root);
  options.changeProfile?.(selected);
  if (options.checkpointHistory) {
    writeFileSync(join(root, 'TEST-input-profile.json'), JSON.stringify(selected));
    t.diagnostic(`TEST restore state: ${root}`);
  }
  let input = new PassThrough();
  let output = new PassThrough();
  const frames: { id: number; result?: unknown; error?: unknown }[] = [];
  let tail = '';
  const receive = (chunk: Buffer) => {
    tail += chunk.toString();
    let newline: number;
    while ((newline = tail.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(tail.slice(0, newline)));
      tail = tail.slice(newline + 1);
    }
  };
  output.on('data', receive);
  const contexts: MemberProviderContext[] = [];
  let session: ControlledSession | undefined;
  let sealed = false;
  let ready = false;
  let cleanupCalls = 0;
  let opens = 0;
  const restored: unknown[] = [];
  const composition = {
    createProvider(context: MemberProviderContext): MemberProvider {
      contexts.push(context);
      options.onProvider?.(context);
      session = new ControlledSession(context.onProgress);
      const capturedSession = session;
      if (options.checkpointHistory)
        session.checkpoint = () => ({
          ok: true,
          value: { history: capturedSession.submits.map((input) => input.content) },
        });
      if (options.unknownCleanup) session.cleanup = 'unknown';
      return {
        factory: {
          open: async () => {
            opens++;
            if (context.request.checkpointRef)
              restored.push(
                await context.readCheckpoint(context.request.checkpointRef, context.request)
              );
            const opened = await (options.open ?? {
              driver: session!,
              capabilities: [...context.request.requiredCapabilities],
            });
            const source: Session = opened.driver;
            return {
              ...opened,
              driver: {
                sessionRef: source.sessionRef,
                submit: (input) => source.submit(input),
                observe: () => source.observe(),
                respondToInteraction: (ref, reply) => source.respondToInteraction(ref, reply),
                interrupt: (ref) => source.interrupt(ref),
                checkpoint: () => source.checkpoint(),
                close: async () => {
                  ready = false;
                  return source.close();
                },
                checkReadiness: async () => {
                  const proof = await source.checkReadiness();
                  ready = proof.ok;
                  return proof;
                },
              },
            };
          },
        },
        isReady: () => ready && !sealed && context.isCurrent(),
        initialContextEvidence: () =>
          ready && !sealed && context.isCurrent()
            ? {
                kind: 'native-configuration',
                contextDigest: initialContextDigest(context.instructions),
                generation: context.endpoint.binding.generation,
                configRevision: context.request.configRevision,
              }
            : undefined,
        seal: () => {
          sealed = true;
        },
        cleanup: async () => {
          cleanupCalls++;
          options.onCleanup?.();
          return !options.unknownCleanup;
        },
      };
    },
  };
  // Lifecycle cases await real disk-backed cleanup; transport watchdog latency is tested separately.
  const disposeTimeoutMs = options.disposeTimeoutMs ?? 30000;
  let host = createTeamHost(
    selected,
    { input, output, limits: { disposeTimeoutMs } },
    composition
  );
  t.after(async () => {
    await host.dispose();
    if (!options.checkpointHistory) rmSync(root, { recursive: true, force: true });
  });
  const binding = {
    schemaVersion: 1,
    handleId: 'TEST-handle',
    owner: selected.owner,
    scope: selected.teams[0]!.scope,
  };
  let sequence = 0;
  function send(method: string, params: unknown): number {
    const id = ++sequence;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  }
  async function answer(id: number): Promise<unknown> {
    await eventually(() => frames.some((frame) => frame.id === id), `RPC ${id} must answer`);
    const frame = frames.find((candidate) => candidate.id === id)!;
    assert.equal(frame.error, undefined);
    return frame.result;
  }
  const rpc = async (method: string, payload: unknown, overrides = {}) =>
    answer(
      send(method, {
        commandId: `rpc-${sequence + 1}`,
        binding,
        payload,
        ...overrides,
      })
    );
  await answer(send('host.handshake', { protocolVersion: 1 }));
  const runtimeBinding: RuntimeBinding = {
    backendId: selected.owner.ownerId,
    teamId: binding.scope.teamId,
    runId: binding.scope.runId,
    memberId: 'alice-id',
    generation: '1',
  };
  return {
    root,
    restored,
    async restart() {
      const closed = await host.dispose();
      assert.equal(closed.cleanup, 'completed', 'original Host cleanup must finish before explicit cold restart');
      input = new PassThrough();
      output = new PassThrough();
      frames.length = 0;
      tail = '';
      sealed = false;
      ready = false;
      output.on('data', receive);
      host = createTeamHost(
        selected,
        { input, output, limits: { disposeTimeoutMs } },
        composition
      );
      await answer(send('host.handshake', { protocolVersion: 1 }));
    },
    selected,
    binding,
    host,
    contexts,
    frames,
    send,
    answer,
    rpc,
    runtimeBinding,
    session: () => {
      assert.ok(session);
      return session;
    },
    sealed: () => sealed,
    opens: () => opens,
    cleanupCalls: () => cleanupCalls,
  };
}

async function tool(context: MemberProviderContext, name: string, args: Record<string, unknown>) {
  const response = await fetch(context.endpoint.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${context.endpoint.bearerToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'TEST-tool',
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = (await response.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  assert.equal(typeof body.result.content[0]?.text, 'string');
  const value: unknown = JSON.parse(body.result.content[0]!.text);
  return { status: response.status, result: { isError: body.result.isError, value } };
}

test('stopped fresh capture admits its exact probe profile and cold replay retains the original check', async (t) => {
  const prepared: string[] = [];
  let runs = 0;
  t.mock.method(ClaudeManagementCoordinator.prototype, 'prepareProbe', (input: { profileId: string }) => {
    prepared.push(input.profileId);
    return { timeoutMs: 10000, run: async () => { runs++; return true; }, close: async () => true };
  });
  const f = await fixture(t, {
    changeProfile(profile) {
      profile.teams[0]!.members = profile.teams[0]!.members.slice(0, 1);
      profile.teams[0]!.members[0]!.role = 'lead';
    },
  });
  const roster = (await f.rpc('team.roster.read', {})) as { value: TeamRosterConfiguration };
  assert.equal((await f.rpc('team.roster.replace', {
    expectedRevision: roster.value.revision,
    members: [],
    savedSettings: { cwd: f.root, providerId: 'anthropic', model: 'TEST-fresh-model', effort: 'medium', limitContext: true },
  }, { commandId: 'TEST-probe-source' }) as { ok: boolean }).ok, true);
  const captured = (await f.rpc('team.launch.capture', { rosterCommandId: 'TEST-probe-source' }, {
    commandId: 'TEST-probe-capture',
  })) as { ok: boolean; value: { launch: { launchId: string; rosterRevision: string } } };
  assert.equal(captured.ok, true);
  assert.equal((await f.rpc('team.launch.start', {
    launchId: captured.value.launch.launchId, rosterRevision: captured.value.launch.rosterRevision,
  }, {
    commandId: 'TEST-probe-launch',
  }) as { ok: boolean }).ok, true);
  await eventually(() => f.opens() === 1 && f.contexts[0]!.isCurrent(), 'fresh captured runtime opens');
  const expected = teamModelProbeProfile(f.contexts[0]!.profile)!;
  if (expected.provider !== 'claude') assert.fail('TEST-Claude-probe-profile');
  assert.notEqual(expected.profileId, teamModelProbeProfile(f.selected.runtime!.members[0]!)!.profileId);
  const stopped = await f.rpc('runtime.stop', { memberId: 'alice-id' }) as { value: { custody: string; phase: string } };
  assert.equal(stopped.value.custody, 'released');
  assert.equal(stopped.value.phase, 'closed');
  const selection = {
    launchId: captured.value.launch.launchId,
    rosterRevision: captured.value.launch.rosterRevision,
    memberId: 'alice-id', model: 'TEST-fresh-model', effort: 'medium', context: 'model-default',
  };
  const original = { commandId: 'TEST-stopped-original-probe' };
  assert.equal((await f.rpc('team.launch.probe.start', selection, original) as { ok: boolean }).ok, true);
  let completed = await f.rpc('team.launch.probe.read', selection, original);
  const deadline = Date.now() + 5000;
  while ((completed as { value?: { phase: string } }).value?.phase !== 'completed' && Date.now() < deadline) {
    await tick();
    completed = await f.rpc('team.launch.probe.read', selection, original);
  }
  assert.equal((completed as { value?: { phase: string } }).value?.phase, 'completed');
  assert.deepEqual(prepared, [expected.profileId]);
  assert.equal(runs, 1);
  assert.equal((completed as { value: { ok: boolean } }).value.ok, true);
  await f.restart();
  assert.deepEqual(await f.rpc('team.launch.probe.start', selection, original), completed);
  assert.deepEqual(await f.rpc('team.launch.probe.read', selection, original), completed);
  assert.equal(runs, 1, 'cold replay cannot repeat a successful probe');
  assert.equal(f.opens(), 1, 'probe and cold restore cannot open member sessions');
  assert.equal((await f.rpc('team.launch.probe.start', selection, { commandId: 'TEST-new-explicit-probe' }) as { ok: boolean }).ok, true);
  await eventually(() => runs === 2, 'new explicit check admitted after cold restore');
  assert.deepEqual(prepared, [expected.profileId, expected.profileId]);
  const admission = new ClaudeManagementCoordinator([], () => {});
  admission.admitProbeProfile(expected);
  admission.admitProbeProfile(expected);
  assert.throws(() => admission.admitProbeProfile({ ...expected, accountBinding: 'TEST-other-account' }), { code: 'conflict' });
  admission.seal();
  assert.throws(() => admission.admitProbeProfile(expected), { code: 'held' });
});

test('Team model preflight requires current control authority and exact launch selection before any provider allocation', async (t) => {
  const empty = await fixture(t);
  const selected = (await empty.rpc('team.launch.read', {})) as {
    value: { launchId: string; rosterRevision: string };
  };
  assert.deepEqual(
    await empty.rpc('team.launch.probe.read', {
      launchId: selected.value.launchId,
      rosterRevision: selected.value.rosterRevision,
      memberId: 'alice-id',
      model: 'TEST-model',
    }),
    { ok: true, value: null }
  );
  assert.equal(empty.opens(), 0);
  for (const denied of ['control', 'selection', 'member'] as const) {
    const f = await fixture(t, {
      changeProfile(selected) {
        if (denied === 'control') selected.teams[0]!.grants[0]!.permissions = ['read'];
        if (denied === 'member') selected.teams[0]!.grants[1]!.revoked = true;
      },
    });
    const snapshot = (await f.rpc('team.launch.read', {})) as {
      ok: boolean;
      value: { launchId: string; rosterRevision: string };
    };
    assert.equal(snapshot.ok, true);
    assert.deepEqual(
      await f.rpc('team.launch.probe.start', {
        launchId: snapshot.value.launchId,
        rosterRevision: denied === 'selection' ? 'TEST-stale' : snapshot.value.rosterRevision,
        memberId: 'alice-id',
        model: 'TEST-model',
      }),
      { ok: false, code: denied === 'selection' ? 'conflict' : 'forbidden', outcome: 'rejected' }
    );
    assert.equal(f.opens(), 0);
  }
});

test(
  'NDJSON human messages auto-admit once and terminal events pump the next input without dispatch RPC',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const message = {
      operation: 'message.send',
      payload: { to: 'alice', text: 'first human message' },
    };
    const first = (await f.rpc('team.execute', message, { commandId: 'human-first' })) as {
      ok: boolean;
      value: CommandReceipt;
    };
    assert.equal(first.ok, true);
    assert.equal(first.value.phase, 'completed');
    assert.equal(f.opens(), 0, 'message admission does not allocate a provider implicitly');
    assert.deepEqual(await f.rpc('team.execute', message, { commandId: 'human-first' }), first);
    assert.equal(
      ((await f.rpc('runtime.open', { memberId: 'alice-id' })) as { ok: boolean }).ok,
      true
    );
    await eventually(
      () => f.session().submits.length === 1,
      'open must kick pending human delivery'
    );
    await f.rpc('team.execute', {
      operation: 'message.send',
      payload: { to: 'alice', text: 'second human message' },
    });
    await tick();
    assert.equal(f.session().submits.length, 1, 'second prompt must await the first terminal');
    f.session().finish(0);
    await eventually(
      () => f.session().submits.length === 2,
      'persisted result must kick the next input'
    );
    assert.deepEqual(
      f.session().submits.map((input) => input.content),
      ['first human message', 'second human message']
    );
    assert.equal(f.session().submits[0]?.inputId, first.value.effects.deliveryId);
    assert.notEqual(f.session().submits[0]?.operationRef, f.session().submits[1]?.operationRef);
    f.session().finish(1);
    await tick();
    const state = (await f.rpc('runtime.read', { memberId: 'alice-id' })) as {
      value: { inputs: { phase: string }[] };
    };
    assert.deepEqual(
      state.value.inputs.map((row) => row.phase),
      ['terminal', 'terminal']
    );
    assert.equal(f.opens(), 1);
    assert.equal(f.session().submits.length, 2);
  }
);

test(
  'member HTTP MCP and Desktop transport share canonical Tasks and enforce member/scope authority',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.rpc('runtime.open', { memberId: 'alice-id' });
    const context = f.contexts[0]!;
    const created = await tool(context, 'task_create', {
      commandId: 'alice-task',
      subject: 'MCP canonical Task',
      owner: 'alice',
    });
    assert.equal(created.status, 200);
    const receipt = created.result.value as CommandReceipt;
    assert.equal(receipt.phase, 'completed');
    assert.equal(receipt.principalId, 'alice-session');
    const started = await tool(context, 'task_start', {
      commandId: 'alice-start',
      taskId: receipt.effects.taskId,
    });
    assert.equal((started.result.value as CommandReceipt).phase, 'completed');
    const task = (await f.rpc('team.task.get', { taskId: receipt.effects.taskId })) as {
      value: { owner: string; status: string };
    };
    assert.equal(task.value.owner, 'alice');
    assert.equal(task.value.status, 'in_progress');
    const taskPath = join(f.root, 'tasks', 'test-runtime-host', `${receipt.effects.taskId}.json`);
    const before = readFileSync(taskPath, 'utf8');
    const forged = await tool(context, 'task_start', {
      commandId: 'forged-member',
      taskId: receipt.effects.taskId,
      memberId: 'bob-id',
    });
    assert.deepEqual(forged.result.value, { error: { code: 'invalid' } });
    assert.equal(readFileSync(taskPath, 'utf8'), before);
    assert.deepEqual(await f.rpc('runtime.open', { memberId: 'bob-id' }), {
      ok: false,
      code: 'invalid',
      outcome: 'rejected',
    });
    assert.deepEqual(
      await f.rpc(
        'runtime.read',
        { memberId: 'alice-id' },
        {
          binding: { ...f.binding, scope: { ...f.binding.scope, runId: 'forged-run' } },
        }
      ),
      { ok: false, code: 'forbidden', outcome: 'rejected' }
    );
    const other = (await f.rpc('team.execute', {
      operation: 'task.create',
      payload: { subject: 'Bob task', owner: 'bob' },
    })) as { value: CommandReceipt };
    const wrong = await tool(context, 'task_start', {
      commandId: 'wrong-assignee',
      taskId: other.value.effects.taskId,
    });
    assert.equal(wrong.result.isError, true);
    assert.equal((wrong.result.value as CommandReceipt).phase, 'rejected');
    assert.equal(f.opens(), 1);
  }
);

test(
  'runtime projections redact private provider identities; missing human control and revoked member grants refuse allocation',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.rpc('runtime.open', { memberId: 'alice-id' });
    await f.rpc('team.execute', {
      operation: 'message.send',
      payload: { to: 'alice', text: 'interaction prompt' },
    });
    await eventually(() => f.session().submits.length === 1, 'human prompt must dispatch');
    const input = f.session().submits[0]!;
    f.session().emit({
      kind: 'interaction',
      sessionRef: f.session().sessionRef,
      inputId: input.inputId,
      operationRef: input.operationRef,
      interactionRef: 'safe-interaction',
      request: { kind: 'permission', tool: 'TEST-tool', input: {} },
    });
    await tick();
    const view = (await f.rpc('runtime.read', { memberId: 'alice-id' })) as {
      value: { interactions: unknown[] };
    };
    assert.equal(view.value.interactions.length, 1);
    const serialized = JSON.stringify(f.frames);
    for (const secret of [
      'PRIVATE-native-session',
      'PRIVATE-config-session',
      'PRIVATE-config-revision',
      'PRIVATE-account',
      'PRIVATE-environment-token',
      'PRIVATE-model',
      f.contexts[0]!.endpoint.bearerToken,
      f.contexts[0]!.endpoint.url,
      input.operationRef,
      f.root,
    ])
      assert.equal(serialized.includes(secret), false, `public frames must omit ${secret}`);
    for (const denied of ['human-control', 'revoked-member'] as const) {
      const restricted = await fixture(t, {
        changeProfile(selected) {
          if (denied === 'human-control') selected.teams[0]!.grants[0]!.permissions = ['read'];
          else selected.teams[0]!.grants[1]!.revoked = true;
        },
      });
      const opened = (await restricted.rpc('runtime.open', { memberId: 'alice-id' })) as {
        ok: boolean;
      };
      assert.equal(opened.ok, false, denied);
      assert.equal(restricted.opens(), 0, 'authority failure must precede provider creation');
    }
  }
);

test(
  'dispose seals a pending provider open before late allocation and retains unknown custody as cleanup debt',
  { timeout: 180000 },
  async (t) => {
    const opening = deferred<Awaited<ReturnType<DriverFactory['open']>>>();
    const f = await fixture(t, { open: opening.promise, unknownCleanup: true, disposeTimeoutMs: 180000 });
    f.send('runtime.open', {
      commandId: 'pending-open',
      binding: f.binding,
      payload: { memberId: 'alice-id' },
    });
    await eventually(() => f.opens() === 1, 'provider factory must be pending');
    const closing = f.host.dispose();
    assert.equal(f.sealed(), true, 'seal must occur synchronously, before late allocation');
    assert.equal(f.contexts[0]!.isCurrent(), false);
    opening.resolve({ driver: f.session(), capabilities: ['session.conversation'] });
    assert.deepEqual(await closing, { reason: 'disposed', cleanup: 'failed' });
    assert.equal(f.session().submits.length, 0);
    assert.ok(f.session().closeCalls >= 1, 'late native allocation must enter owned cleanup');
    assert.equal(f.cleanupCalls(), 1);
    const record = new FileRuntimeStore(f.root).fenced(f.runtimeBinding, (tx) => tx.get());
    assert.equal(record?.sealed, true);
    assert.notEqual(record?.phase, 'closed', 'cleanup debt must never become definitive closed');
    assert.equal(record?.custody, 'unknown', 'unknown close must survive host disposal');
    assert.equal(f.opens(), 1);
  }
);

for (const outcome of ['late-driver', 'unknown-driver', 'factory-rejection'] as const) {
  test(`pending open cleanup precedes readiness: ${outcome}`, { timeout: 180000 }, async (t) => {
    const entered = deferred<void>();
    const opening = deferred<Awaited<ReturnType<DriverFactory['open']>>>();
    let sealedAtCleanup = false;
    const f = await fixture(t, {
      open: opening.promise.then((value) => {
        if (outcome === 'factory-rejection') throw new Error('TEST native transport closed during open');
        return value;
      }),
      unknownCleanup: outcome === 'unknown-driver',
      disposeTimeoutMs: 180000,
      onProvider: () => entered.resolve(),
      onCleanup() {
        const record = new FileRuntimeStore(f.root).fenced(f.runtimeBinding, (tx) => tx.get());
        sealedAtCleanup = record?.sealed === true;
        opening.resolve({ driver: f.session(), capabilities: ['session.conversation'] });
      },
    });
    f.send('runtime.open', {
      commandId: 'cleanup-gated-open', binding: f.binding, payload: { memberId: 'alice-id' },
    });
    await entered.promise;
    await tick();
    assert.equal(f.opens(), 1, 'actual controlled provider factory entered');
    const closing = f.host.dispose();
    try {
      await tick();
      assert.equal(f.cleanupCalls(), 1, 'captured child cleanup cannot wait for factory readiness');
      assert.equal(sealedAtCleanup, true, 'durable Runtime seal precedes physical cleanup');
      assert.equal(f.contexts[0]!.isCurrent(), false);
      const result = await closing;
      const record = new FileRuntimeStore(f.root).fenced(f.runtimeBinding, (tx) => tx.get());
      assert.equal(record?.sealed, true);
      assert.equal(record?.nativeReady, false);
      assert.equal(f.opens(), 1);
      assert.equal(f.cleanupCalls(), 1, 'reuse original pending-open cleanup result');
      assert.equal(f.session().submits.length, 0);
      if (outcome === 'late-driver') {
        assert.equal(result.cleanup, 'completed');
        assert.equal(record?.phase, 'closed');
        assert.equal(record?.custody, 'released');
        assert.equal(f.session().closeCalls, 1);
      } else {
        assert.equal(result.cleanup, 'failed');
        assert.equal(record?.phase, 'held');
        assert.equal(record?.custody, 'unknown', 'physical cleanup alone cannot manufacture SPI release');
        assert.equal(record?.diagnostic, outcome === 'factory-rejection' ? 'open-unknown' : 'close-unknown');
        assert.equal(f.session().closeCalls, outcome === 'factory-rejection' ? 0 : 1);
      }
    } finally {
      // Unblock only a failing pre-fix test; the successful path releases solely from cleanup.
      opening.resolve({ driver: f.session(), capabilities: ['session.conversation'] });
      await closing;
    }
  });
}

for (const transition of ['stop', 'reconcile'] as const) {
  test(`pending provider cleanup survives ${transition} before dispose`, { timeout: 180000 }, async (t) => {
    const entered = deferred<void>();
    const opening = deferred<Awaited<ReturnType<DriverFactory['open']>>>();
    let sealedAtCleanup = false;
    const f = await fixture(t, {
      open: opening.promise,
      disposeTimeoutMs: 180000,
      onProvider: () => entered.resolve(),
      onCleanup() {
        sealedAtCleanup = new FileRuntimeStore(f.root).fenced(f.runtimeBinding, tx => tx.get()?.sealed) === true;
        opening.resolve({ driver: f.session(), capabilities: ['session.conversation'] });
      },
    });
    f.send('runtime.open', {
      commandId: 'transitioned-cleanup-gated-open', binding: f.binding, payload: { memberId: 'alice-id' },
    });
    await entered.promise;
    await tick();
    assert.equal(f.opens(), 1);
    const changed = await f.rpc(`runtime.${transition}`, { memberId: 'alice-id' }) as {
      ok: boolean; value: { phase: string; custody: string };
    };
    assert.equal(changed.ok, true);
    assert.equal(changed.value.phase, 'held');
    assert.equal(changed.value.custody, 'unknown');
    assert.equal(f.cleanupCalls(), 0, 'the factory remains pending after the business control');
    assert.equal(
      new FileRuntimeStore(f.root).fenced(f.runtimeBinding, tx => tx.get()?.sealed),
      transition === 'stop', 'reconcile changes custody without sealing the pending open'
    );
    const closing = f.host.dispose();
    try {
      await tick();
      assert.equal(f.cleanupCalls(), 1, 'driver-less cleanup cannot depend on mutable Runtime phase');
      assert.equal(sealedAtCleanup, true);
      assert.equal((await closing).cleanup, 'completed');
      const record = new FileRuntimeStore(f.root).fenced(f.runtimeBinding, tx => tx.get());
      assert.equal(record?.sealed, true);
      assert.equal(record?.nativeReady, false);
      assert.equal(record?.phase, 'closed');
      assert.equal(record?.custody, 'released');
      assert.equal(f.session().closeCalls, 1);
      assert.equal(f.session().submits.length, 0);
      assert.equal(f.opens(), 1);
      assert.equal(f.cleanupCalls(), 1);
    } finally {
      // Release only a failing pre-fix test; success is released solely by owned cleanup.
      opening.resolve({ driver: f.session(), capabilities: ['session.conversation'] });
      await closing;
    }
  });
}

test('allocated driver checkpoint and close precede captured process cleanup', { timeout: 180000 }, async (t) => {
  const order: string[] = [];
  const f = await fixture(t, { disposeTimeoutMs: 180000, onCleanup: () => { order.push('cleanup'); } });
  await f.rpc('runtime.open', { memberId: 'alice-id' });
  f.session().checkpoint = () => { order.push('checkpoint'); return { ok: false, code: 'unsupported' }; };
  const close = f.session().close;
  f.session().close = async () => { order.push('close'); return close(); };
  assert.equal((await f.host.dispose()).cleanup, 'completed');
  assert.deepEqual(order, ['checkpoint', 'close', 'cleanup']);
});

test(
  'expired MCP proof holds the next admitted input; disposing a never-opened profile performs no allocation',
  { timeout: 10000 },
  async (t) => {
    // Keep the pre-expiry phase independent of filesystem and parallel-suite latency.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const untouched = await fixture(t);
    assert.deepEqual(await untouched.host.dispose(), { reason: 'disposed', cleanup: 'completed' });
    assert.equal(untouched.opens(), 0);
    assert.equal(untouched.contexts.length, 0);
    assert.equal(untouched.cleanupCalls(), 0);

    const f = await fixture(t, {
      changeProfile(selected) {
        selected.runtime!.members[0]!.mcpLifetimeMs = 1000;
      },
    });
    const opened = (await f.rpc('runtime.open', { memberId: 'alice-id' })) as {
      value: { nativeReady: boolean };
    };
    assert.equal(opened.value.nativeReady, true);
    await f.rpc('team.execute', {
      operation: 'message.send',
      payload: { to: 'alice', text: 'before expiry' },
    });
    await eventually(
      () => f.session().submits.length === 1,
      'valid proof must allow the first prompt'
    );
    f.session().finish(0);
    await tick();
    t.mock.timers.tick(1100);
    assert.equal(f.contexts[0]!.isCurrent(), false, 'the actual endpoint lifetime must expire');
    const sent = (await f.rpc('team.execute', {
      operation: 'message.send',
      payload: { to: 'alice', text: 'after expiry' },
    })) as { ok: boolean };
    assert.equal(sent.ok, true, 'expired native dependency must not erase the business message');
    await f.rpc('runtime.dispatch', { memberId: 'alice-id' });
    const view = (await f.rpc('runtime.read', { memberId: 'alice-id' })) as {
      value: { nativeReady: boolean; inputs: { phase: string }[] };
    };
    assert.equal(view.value.nativeReady, false);
    assert.deepEqual(
      view.value.inputs.map((row) => row.phase),
      ['terminal', 'admitted']
    );
    assert.equal(f.session().submits.length, 1, 'stale MCP readiness must not reach SPI.submit');
    assert.equal(f.opens(), 1, 'dependency expiry must not create a replacement session');
  }
);

test(
  'Codex Host selection uses its actual public capability vocabulary and keeps private config off RPC',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, {
      changeProfile(selected) {
        const member = selected.runtime!.members[0]!;
        if (member.provider !== 'claude') throw new Error('Expected Claude fixture');
        const {
          nativeTools: _tools,
          autoAllowedTools: _allowed,
          configNamespace: _namespace,
          nativeOptions: _options,
          ...common
        } = member;
        selected.runtime!.members[0] = {
          ...common,
          provider: 'codex',
          protocolRevision: '0.162.0',
          environment: { ...common.environment, CODEX_HOME: common.cwd },
          nativeOptions: { approvalPolicy: 'on-request', sandbox: 'read-only' },
        };
      },
    });
    const opened = (await f.rpc('runtime.open', { memberId: 'alice-id' })) as {
      ok: boolean;
      value: { nativeReady: boolean };
    };
    assert.equal(opened.ok, true);
    assert.equal(opened.value.nativeReady, true);
    assert.deepEqual(f.contexts[0]!.request.requiredCapabilities, ['text', 'tools']);
    assert.equal(f.contexts[0]!.profile.provider, 'codex');
    await f.rpc('team.execute', {
      operation: 'message.send',
      payload: { to: 'alice', text: 'TEST Codex message' },
    });
    await eventually(
      () => f.session().submits.length === 1,
      'captured Codex selection must receive exactly one input'
    );
    f.session().finish(0);
    await tick();
    const stopped = (await f.rpc('runtime.stop', { memberId: 'alice-id' })) as {
      value: { phase: string; custody: string };
    };
    assert.equal(stopped.value.phase, 'closed');
    assert.equal(stopped.value.custody, 'released');
    const publicBytes = JSON.stringify(f.frames);
    for (const secret of [
      'PRIVATE-environment-token',
      'PRIVATE-account',
      'PRIVATE-config-session',
      f.root,
    ])
      assert.equal(publicBytes.includes(secret), false);
  }
);

test(
  'activity RPC pages normalized native observations with opaque cursor, bounded snapshots and explicit gaps',
  // Persisting and paging this bounded native event fixture validates correctness, not latency.
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const before = (await f.rpc('runtime.activity.snapshot', { memberId: 'alice-id' })) as {
      ok: boolean;
      value: ActivityPage;
    };
    assert.equal(before.ok, true);
    assert.equal(before.value.state, null);
    assert.deepEqual(before.value.events, []);
    await f.rpc('runtime.open', { memberId: 'alice-id' });
    await f.rpc('team.execute', {
      operation: 'message.send',
      payload: { to: 'alice', text: 'Produce UI observations' },
    });
    await eventually(() => f.session().submits.length === 1, 'activity source input must dispatch');
    const input = f.session().submits[0]!;
    const source = {
      sessionRef: f.session().sessionRef,
      inputId: input.inputId,
      operationRef: input.operationRef,
    };
    for (let index = 0; index < 16; index++)
      f.session().emit({
        ...source,
        kind: 'text',
        messageRef: `message-${index}`,
        block: 0,
        text: `${index}:` + 'x'.repeat(23 * 1024),
        phase: 'complete',
      });
    f.session().emit({
      ...source,
      kind: 'tool',
      messageRef: 'tool-message',
      toolRef: 'tool-1',
      name: 'TEST-tool',
      input: { path: 'test.txt' },
    });
    f.session().emit({
      ...source,
      kind: 'tool-result',
      toolRef: 'tool-1',
      content: 'Tool output',
      isError: false,
    });
    f.session().emit({ ...source, kind: 'usage', inputTokens: 17, outputTokens: 9 });
    f.session().emit({
      ...source,
      kind: 'interaction',
      interactionRef: 'permission-ui',
      request: { kind: 'permission', tool: 'TEST-tool', input: { command: 'TEST-only' } },
    });
    f.session().finish(0);
    await tick();
    const snapshot = (await f.rpc('runtime.activity.snapshot', { memberId: 'alice-id' })) as {
      ok: boolean;
      value: ActivityPage;
    };
    assert.equal(snapshot.ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 256 * 1024);
    assert.equal(
      snapshot.value.gap?.reason,
      'retention',
      'bounded latest text must expose omitted history'
    );
    assert.ok(snapshot.value.latest!.text.length > 0 && snapshot.value.latest!.text.length < 16);
    assert.equal(snapshot.value.latest!.tools.length, 2);
    assert.equal(snapshot.value.latest!.usage.length, 1);
    assert.equal(snapshot.value.latest!.interactions.length, 1);
    assert.deepEqual(snapshot.value.events, []);
    let cursor = before.value.cursor;
    const observations: ActivityPage['events'] = [];
    let pages = 0;
    for (;;) {
      const response = (await f.rpc('runtime.activity.feed', { memberId: 'alice-id', cursor })) as {
        ok: boolean;
        value: ActivityPage;
      };
      assert.equal(response.ok, true);
      const page = response.value;
      assert.ok(Buffer.byteLength(JSON.stringify(response)) < 128 * 1024);
      assert.ok(page.events.length <= 64);
      observations.push(...page.events);
      cursor = page.cursor;
      pages++;
      if (!page.hasMore) break;
      assert.ok(pages < 10, 'opaque cursor must advance through finite history');
    }
    assert.ok(pages > 1, 'large normalized text must use hasMore pages');
    assert.equal(new Set(observations.map((event) => event.sequence)).size, observations.length);
    for (const kind of ['text', 'tool', 'tool-result', 'usage', 'interaction', 'result'])
      assert.ok(
        observations.some((event) => event.data.kind === kind),
        kind
      );
    assert.ok(
      observations
        .filter((event) => event.data.kind === 'text')
        .every((event) => event.inputId === input.inputId)
    );
    const caughtUp = (await f.rpc('runtime.activity.feed', { memberId: 'alice-id', cursor })) as {
      value: ActivityPage;
    };
    assert.deepEqual(caughtUp.value.events, []);
    assert.equal(caughtUp.value.hasMore, false);
    const changed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { resource: string };
    changed.resource = 'f'.repeat(64);
    const wrong = (await f.rpc('runtime.activity.feed', {
      memberId: 'alice-id',
      cursor: Buffer.from(JSON.stringify(changed)).toString('base64url'),
    })) as { value: ActivityPage };
    assert.equal(wrong.value.gap?.reason, 'cursor');
    const serialized = JSON.stringify([snapshot, observations]);
    for (const secret of [
      'PRIVATE-native-session',
      'PRIVATE-config-session',
      'PRIVATE-account',
      'PRIVATE-environment-token',
      input.operationRef,
      f.contexts[0]!.endpoint.bearerToken,
      f.root,
    ])
      assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('operationRef'), false);
    assert.equal(serialized.includes('binding'), false);
  }
);

test(
  'activity snapshot/feed recheck current human read grants and reject authority overrides',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const snapshot = (await f.rpc('runtime.activity.snapshot', { memberId: 'alice-id' })) as {
      value: ActivityPage;
    };
    assert.deepEqual(
      await f.rpc('runtime.activity.feed', { memberId: 'alice-id', cursor: 'not-json' }),
      { ok: false, code: 'invalid', outcome: 'rejected' }
    );
    assert.deepEqual(await f.rpc('runtime.activity.snapshot', { memberId: 'bob-id' }), {
      ok: false,
      code: 'invalid',
      outcome: 'rejected',
    });
    assert.deepEqual(
      await f.rpc('runtime.activity.snapshot', { memberId: 'alice-id', binding: f.runtimeBinding }),
      { ok: false, code: 'invalid', outcome: 'rejected' }
    );
    // TEST-owned persisted authority changes after the first successful read.
    const path = join(f.root, 'teams', 'test-runtime-host', '.host-owner', 'state.json');
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      grants: { principalId: string; revoked?: boolean }[];
    };
    state.grants.find((grant) => grant.principalId === 'human')!.revoked = true;
    writeFileSync(path, JSON.stringify(state));
    for (const [operation, payload] of [
      ['runtime.activity.snapshot', { memberId: 'alice-id' }],
      ['runtime.activity.feed', { memberId: 'alice-id', cursor: snapshot.value.cursor }],
      ['team.launch.configuration.read', {}],
    ] as const)
      assert.deepEqual(await f.rpc(operation, payload), {
        ok: false,
        code: 'forbidden',
        outcome: 'rejected',
      });
    assert.equal(f.opens(), 0, 'activity reads must never allocate native providers');
  }
);

test('production aggregate launch RPC preserves configured and missing roster members and idempotent scoped progress', async (t) => {
  const f = await fixture(t);
  type Summary = {
    launchId: string;
    rosterRevision: string;
    expected: number;
    ready: number;
    status: string;
    members: {
      memberId: string;
      attempt: { attemptId: string; status: string; contextApplied: boolean };
    }[];
  };
  const before = (await f.rpc('team.launch.read', {})) as { ok: true; value: Summary };
  assert.equal(before.ok, true);
  assert.equal(before.value.expected, 2);
  assert.equal(f.opens(), 0);
  const payload = { launchId: before.value.launchId, rosterRevision: before.value.rosterRevision };
  const accepted = (await f.rpc('team.launch.start', payload, { commandId: 'stable-launch' })) as {
    ok: boolean;
  };
  assert.equal(accepted.ok, true);
  await eventually(() => f.opens() === 1, 'only configured member opens');
  let summary: Summary = before.value;
  for (let count = 0; count < 20; count++) {
    summary = ((await f.rpc('team.launch.read', {})) as { value: Summary }).value;
    if (summary.ready === 1) break;
    await tick();
  }
  assert.equal(summary.ready, 1);
  assert.equal(summary.expected, 2);
  assert.equal(summary.status, 'partial');
  assert.equal(
    summary.members.find((member) => member.memberId === 'alice-id')?.attempt.contextApplied,
    true
  );
  assert.equal(
    summary.members.find((member) => member.memberId === 'bob-id')?.attempt.status,
    'failed'
  );
  const aliceAttempt = summary.members.find((member) => member.memberId === 'alice-id')!.attempt
    .attemptId;
  assert.equal(
    ((await f.rpc('team.launch.start', payload, { commandId: 'stable-launch' })) as { ok: boolean })
      .ok,
    true
  );
  assert.equal(f.opens(), 1);
  const retry = (await f.rpc(
    'team.launch.retry',
    { ...payload, attemptId: 'retry-missing', memberIds: ['bob-id'] },
    { commandId: 'retry-missing-command' }
  )) as { ok: boolean; value: Summary };
  assert.equal(retry.ok, true);
  assert.equal(
    retry.value.members.find((member) => member.memberId === 'alice-id')?.attempt.attemptId,
    aliceAttempt
  );
  assert.equal(f.opens(), 1);
});

test('launch options are durably selected before provider creation and replay survives Host restart without new allocation', async (t) => {
  let persistedBeforeFactory = false;
  const f = await fixture(t, {
    changeProfile(selected) {
      const member = selected.runtime!.members[0]!;
      if (member.provider === 'claude') member.autoAllowedTools = ['Bash'];
    },
    onProvider(context) {
      const path = join(
        context.profile.cwd,
        'teams/test-runtime-host/.host-owner/launches',
        runtimeDigest('TEST-run') + '.json'
      );
      const record = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(record.preparation.commandId, 'TEST-configured-start');
      assert.equal(record.preparation.members[0].configuration.model, 'TEST-selected');
      assert.equal(
        record.definition.members[0].configurationDigest,
        runtimeDigest(context.profile)
      );
      persistedBeforeFactory = true;
    },
  });
  const initial = (await f.rpc('team.launch.read', {})) as {
    value: { launchId: string; rosterRevision: string };
  };
  // An ordinary queued message may exist before configuration; no native opening
  // has been claimed, so its original delivery must survive selected settings.
  await f.rpc('team.execute', {
    operation: 'message.send',
    payload: { to: 'alice', text: 'TEST-queued-before-start' },
  });
  const payload = {
    launchId: initial.value.launchId,
    rosterRevision: initial.value.rosterRevision,
    configuration: {
      members: [
        {
          memberId: 'alice-id',
          model: 'TEST-selected',
          effort: 'high',
          fastMode: false,
          permissions: 'manual',
          context: 'one-million',
        },
      ],
    },
  };
  const result = (await f.rpc('team.launch.start', payload, {
    commandId: 'TEST-configured-start',
  })) as { ok: boolean; value: { rosterRevision: string } };
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.value.rosterRevision, initial.value.rosterRevision);
  await eventually(
    () => f.opens() === 1 && f.session().submits.length === 1,
    'selected provider receives original queued delivery'
  );
  assert.equal(persistedBeforeFactory, true);
  const captured = f.contexts[0]!.profile;
  assert.equal(captured.model, 'TEST-selected');
  assert.equal(captured.provider, 'claude');
  if (captured.provider === 'claude') {
    assert.deepEqual(captured.autoAllowedTools, []);
    assert.deepEqual(captured.nativeOptions, {
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      effort: 'high',
      fastMode: false,
      context: 'one-million',
    });
  }
  assert.equal(f.session().submits[0]!.content, 'TEST-queued-before-start');
  f.session().finish(0);
  assert.equal(
    (
      (await f.rpc('team.launch.start', payload, { commandId: 'TEST-configured-start' })) as {
        ok: boolean;
      }
    ).ok,
    true
  );
  assert.equal(f.opens(), 1);
  const changed = structuredClone(payload);
  assert.deepEqual(
    await f.rpc(
      'team.launch.start',
      {
        launchId: payload.launchId,
        rosterRevision: result.value.rosterRevision,
      },
      { commandId: 'TEST-configured-start' }
    ),
    {
      ok: false,
      code: 'conflict',
      outcome: 'rejected',
      reason: 'launch-configuration',
    },
    'dropping configuration fields cannot change the original intent'
  );
  changed.configuration.members[0]!.model = 'TEST-different';
  assert.deepEqual(
    await f.rpc('team.launch.start', changed, { commandId: 'TEST-configured-start' }),
    {
      ok: false,
      code: 'conflict',
      outcome: 'rejected',
      reason: 'launch-configuration',
    }
  );
  await f.restart();
  assert.equal(
    (
      (await f.rpc('team.launch.start', payload, { commandId: 'TEST-configured-start' })) as {
        ok: boolean;
      }
    ).ok,
    true
  );
  assert.equal(f.opens(), 1, 'replay cannot reopen the already closed runtime');
  assert.equal(
    f.selected.runtime!.members[0]!.model,
    'PRIVATE-model',
    'captured base profile remains immutable'
  );
  const saved = (await f.rpc('team.launch.configuration.read', {})) as {
    ok: boolean;
    value: { members: { memberId: string; selected: Record<string, unknown> }[] };
  };
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.value.members[0]!.selected, {
    provider: 'claude',
    workspace: f.root,
    model: 'TEST-selected',
    capabilities: ['model', 'effort', 'fastMode', 'permissions', 'context'],
    effort: 'high',
    fastMode: false,
    context: 'one-million',
    permissions: 'manual',
  });
  assert.equal(f.opens(), 1, 'configuration read never allocates');
  assert.equal(JSON.stringify(saved).includes('PRIVATE-model'), false);

  const path = join(
    f.root,
    'teams/test-runtime-host/.host-owner/launches',
    runtimeDigest('TEST-run') + '.json'
  );
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.preparation.members[0].configuration.model = 'TEST-corrupt';
  writeFileSync(path, JSON.stringify(record));
  await assert.rejects(f.restart(), 'corrupt prepared options cannot be accepted during recovery');
  assert.equal(f.opens(), 1);
});

test('launch options refuse allocated state and compile every selected provider before any publication or allocation', async (t) => {
  const allocated = await fixture(t);
  await allocated.rpc('runtime.open', { memberId: 'alice-id' });
  const prior = (await allocated.rpc('team.launch.read', {})) as {
    value: { launchId: string; rosterRevision: string };
  };
  assert.deepEqual(
    await allocated.rpc('team.launch.start', {
      launchId: prior.value.launchId,
      rosterRevision: prior.value.rosterRevision,
      configuration: { members: [{ memberId: 'alice-id', model: 'TEST-forbidden-live-change' }] },
    }),
    { ok: false, code: 'conflict', outcome: 'rejected', reason: 'launch-already-allocated' }
  );
  assert.equal(allocated.opens(), 1);
  assert.equal(allocated.contexts[0]!.profile.model, 'PRIVATE-model');
  const f = await fixture(t, {
    changeProfile(selected) {
      const alice = selected.runtime!.members[0]!;
      const {
        nativeTools: _tools,
        autoAllowedTools: _allowed,
        ...common
      } = alice as Extract<typeof alice, { provider: 'claude' }>;
      selected.teams[0]!.members[1]!.delivery = {
        ...selected.teams[0]!.members[0]!.delivery!,
        memberId: 'bob-id',
      };
      selected.teams[0]!.grants.push({
        principalId: 'bob-session',
        memberName: 'bob',
        permissions: ['read', 'task.write', 'message.write'],
      });
      selected.runtime!.members.push({
        ...common,
        provider: 'codex',
        memberId: 'bob-id',
        principalId: 'bob-session',
        sessionId: 'TEST-bob-session',
        protocolRevision: '0.162.0',
        environment: { HOME: alice.cwd, CODEX_HOME: alice.cwd },
        nativeOptions: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
      });
    },
  });
  const original = (await f.rpc('team.launch.read', {})) as {
    value: { launchId: string; rosterRevision: string };
  };
  assert.deepEqual(
    await f.rpc('team.launch.start', {
      launchId: original.value.launchId,
      rosterRevision: original.value.rosterRevision,
      configuration: {
        members: [
          { memberId: 'alice-id', model: 'TEST-must-not-publish' },
          { memberId: 'bob-id', context: 'one-million' },
        ],
      },
    }),
    { ok: false, code: 'invalid', outcome: 'rejected', reason: 'launch-option-unsupported' }
  );
  assertSameLaunch(await f.rpc('team.launch.read', {}), original);
  assert.equal(f.opens(), 0, 'late incompatible provider cannot allocate the earlier member');
  assert.equal(f.contexts.length, 0);
  const accepted = (await f.rpc(
    'team.launch.start',
    {
      launchId: original.value.launchId,
      rosterRevision: original.value.rosterRevision,
      configuration: {
        members: [
          { memberId: 'alice-id', model: 'TEST-Claude-selected' },
          { memberId: 'bob-id', model: 'TEST-Codex-selected', permissions: 'manual' },
        ],
      },
    },
    { commandId: 'TEST-valid-mixed-options' }
  )) as { ok: boolean };
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  await eventually(() => f.opens() === 2, 'both admitted provider configurations open');
  const codex = f.contexts.find((context) => context.profile.provider === 'codex')!.profile;
  assert.equal(codex.model, 'TEST-Codex-selected');
  assert.equal(codex.provider, 'codex');
  if (codex.provider === 'codex') {
    assert.equal(codex.nativeOptions.approvalPolicy, 'on-request');
    assert.equal(codex.nativeOptions.sandbox, 'workspace-write');
  }
});

test('selected checkpoint resumes through a new Host/generation, retains Team delivery ownership and fences stale controls', async (t) => {
  const f = await fixture(t, { checkpointHistory: true });
  const initial = (await f.rpc('team.launch.read', {})) as {
    value: { launchId: string; rosterRevision: string };
  };
  const configuration = {
    members: [
      {
        memberId: 'alice-id',
        model: 'TEST-selected-model',
        effort: 'medium',
        fastMode: false,
        permissions: 'manual',
      },
    ],
  };
  assert.equal(
    (
      (await f.rpc(
        'team.launch.start',
        {
          launchId: initial.value.launchId,
          rosterRevision: initial.value.rosterRevision,
          configuration,
        },
        { commandId: 'TEST-configured-launch' }
      )) as { ok: boolean }
    ).ok,
    true
  );
  const opened = (await f.rpc('runtime.open', { memberId: 'alice-id' })) as {
    ok: boolean;
    value: { generation: string };
  };
  assert.equal(opened.ok, true);
  const messageA = { operation: 'message.send', payload: { to: 'alice', text: 'TEST_HISTORY_A' } };
  const receiptA = await f.rpc('team.execute', messageA, { commandId: 'TEST-original-A' });
  await eventually(() => f.session().submits.length === 1, 'first input dispatched');
  f.session().finish(0);
  await eventually(
    () =>
      new FileRuntimeStore(f.root).fenced(
        f.runtimeBinding,
        (tx) => tx.get()?.inputs[0]?.phase === 'terminal'
      ),
    'first input persisted'
  );
  const captured = (await f.rpc('runtime.checkpoint', {
    memberId: 'alice-id',
    checkpointId: 'TEST-selected',
  })) as { ok: boolean; value: { status: string; reference: string } };
  assert.equal(captured.value.status, 'published');
  await f.rpc('runtime.stop', { memberId: 'alice-id' });
  await f.restart();
  const before = (await f.rpc('team.launch.read', {})) as {
    ok: boolean;
    value: { launchId: string; rosterRevision: string };
  };
  const missing = await f.rpc(
    'runtime.restore',
    {
      memberId: 'alice-id',
      reference: 'cp1-' + 'f'.repeat(64),
      expectedGeneration: opened.value.generation,
    },
    { commandId: 'TEST-missing-resume' }
  );
  assert.deepEqual(missing, { ok: false, code: 'hold', outcome: 'unknown' });
  assert.equal(f.opens(), 1, 'missing selected payload cannot allocate a replacement');
  assertSameLaunch(
    await f.rpc('team.launch.read', {}),
    before,
    'failed source validation cannot change the active selection'
  );
  const restore = {
    memberId: 'alice-id',
    reference: captured.value.reference,
    expectedGeneration: opened.value.generation,
  };
  const concurrent = (await Promise.all([
    f.rpc('runtime.restore', restore, { commandId: 'TEST-resume-original' }),
    f.rpc('runtime.restore', restore, { commandId: 'TEST-resume-original' }),
  ])) as { ok: boolean; value: { generation: string; nativeReady: boolean } }[];
  assert.deepEqual(
    concurrent[1],
    concurrent[0],
    'concurrent retry retains the same original restore'
  );
  const result = concurrent[0]!;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.nativeReady, true);
  assert.deepEqual(
    await f.rpc('team.execute', messageA, { commandId: 'TEST-original-A' }),
    receiptA,
    'old human receipt keeps its original delivery instead of retargeting it'
  );
  assert.equal(f.session().submits.length, 0);
  assert.deepEqual(
    await f.rpc(
      'team.launch.start',
      { launchId: before.value.launchId, rosterRevision: before.value.rosterRevision },
      { commandId: 'TEST-stale-launch' }
    ),
    { ok: false, code: 'conflict', outcome: 'rejected', reason: 'launch-scope' }
  );
  assert.notEqual(result.value.generation, opened.value.generation);
  assert.deepEqual(f.restored, [{ history: ['TEST_HISTORY_A'] }]);
  assert.equal(f.contexts.at(-1)?.request.generation, 2);
  const restoredProfile = f.contexts.at(-1)!.profile;
  assert.equal(restoredProfile.model, 'TEST-selected-model');
  assert.equal(restoredProfile.provider, 'claude');
  if (restoredProfile.provider === 'claude') {
    assert.equal(restoredProfile.nativeOptions?.effort, 'medium');
    assert.equal(restoredProfile.nativeOptions?.fastMode, false);
    assert.equal(restoredProfile.nativeOptions?.permissionMode, 'default');
  }
  assert.equal(f.contexts.at(-1)?.request.checkpointRef, captured.value.reference);
  for (const payload of [
    { memberId: 'alice-id' },
    { memberId: 'alice-id', expectedGeneration: opened.value.generation },
  ])
    assert.deepEqual(await f.rpc('runtime.stop', payload), {
      ok: false,
      code: 'conflict',
      outcome: 'rejected',
    });
  await f.rpc('team.execute', {
    operation: 'message.send',
    payload: { to: 'alice', text: 'TEST_HISTORY_B' },
  });
  await eventually(
    () => f.session().submits.length === 1,
    'new Team delivery reaches restored generation'
  );
  assert.equal(f.session().submits[0]?.content, 'TEST_HISTORY_B');
  f.session().finish(0);
  await f.rpc('runtime.restore', restore, { commandId: 'TEST-resume-original' });
  assert.equal(f.opens(), 2, 'same original restore cannot allocate twice');
  assert.deepEqual(
    await f.rpc(
      'runtime.restore',
      { ...restore, reference: 'cp1-' + 'f'.repeat(64) },
      { commandId: 'TEST-resume-original' }
    ),
    { ok: false, code: 'conflict', outcome: 'rejected' }
  );
  await f.rpc('runtime.stop', {
    memberId: 'alice-id',
    expectedGeneration: result.value.generation,
  });
  await f.restart();
  const recovered = (await f.rpc('runtime.restore', restore, {
    commandId: 'TEST-resume-original',
  })) as { ok: boolean; value: { phase: string; attached: boolean } };
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.value.phase, 'closed');
  assert.equal(recovered.value.attached, false);
  assert.equal(
    f.opens(),
    2,
    'completed original intent cannot adopt/reallocate its retired native session'
  );
  const journalPath = join(
    f.root,
    'teams/test-runtime-host/.host-owner/launches',
    runtimeDigest('TEST-run') + '.json'
  );
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.restorations[0].fingerprint = '0'.repeat(64);
  writeFileSync(journalPath, JSON.stringify(journal));
  await assert.rejects(
    f.restart(),
    'corrupt historical selection cannot authorize retired bindings'
  );
  assert.equal(f.opens(), 2, 'corrupt restore recovery performs no native allocation');
});
