import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { normalizeBinding, runtimeDigest } from '../dist/runtime/identity.js';
import { preparedInputProof } from '../dist/runtime/inputPreparation.js';
import { TeamLaunchOwner } from '../dist/team-launch/TeamLaunchOwner.js';
import { transitionRuntimeMember } from '../dist/composition/transitionRuntimeMember.js';
import { ControlledSession } from './context-test-session.ts';
import type { TestContext } from 'node:test';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { TeamContextEpoch } from '../dist/team/TeamContextReminders.js';
import type { ExpectedLaunchMember } from '../dist/team-launch/contracts.js';
import type { MemberActionInput } from '../dist/team-launch/memberActions.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-context-successor-')));
  const teamBinding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' };
  const binding = {
    backendId: teamBinding.backendId, teamId: teamBinding.teamId, runId: 'TEST-run',
    memberId: 'alice-id', generation: 'original-1',
  };
  let fault: 'second-archive' | 'state' | undefined;
  let archivesWritten = 0;
  class FaultStore extends TeamOwnerStore {
    override write(name: string, value: unknown): void {
      if (name.startsWith('context-epochs/')) {
        if (fault === 'second-archive' && archivesWritten === 1) {
          fault = undefined;
          throw new Error('TEST interrupted archive publication');
        }
        archivesWritten++;
      }
      if (fault === 'state' && name === 'state.json' &&
          (value as OwnerState).contextEpochs?.length === 0) {
        fault = undefined;
        throw new Error('TEST interrupted state publication');
      }
      super.write(name, value);
    }
  }
  const store = new FaultStore(root, teamBinding.teamName);
  const owner = createFilesystemTeamOwner({
    root, binding: teamBinding, store,
    members: [{ name: 'alice', memberId: binding.memberId, role: 'lead',
      settings: { role: 'TEST standing role' }, delivery: { ...binding, teamName: teamBinding.teamName } }],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'message.write'] },
      { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'message.write'] },
    ],
    savedSettings: { cwd: root, prompt: 'TEST standing instructions' },
  });
  const human = owner.connect('human');
  const runtimeStore = new FileRuntimeStore(root);
  const sessions: ControlledSession[] = [];
  const runtime = new RuntimeOwner({
    store: runtimeStore, profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    authorize: (target, action, intent) => intent
      ? owner.authorizeDeliveryIntent(intent, action) : owner.authorizeMemberBinding(target, action),
    canDispatch: () => true,
    driverFactory: { async open(config) {
      const driver = new ControlledSession(config.sessionId);
      sessions.push(driver);
      return { driver, capabilities: ['tools'] };
    } },
    contextObserved(target, epoch) {
      owner.contextReminders.observe('human', target, epoch);
      return undefined;
    },
    prepareInput(target, request) {
      return owner.contextReminders.prepare('human', {
        ...request, binding: target, workspace: root, maxPrefixBytes: 64 * 1024,
      });
    },
    inputPrepared(target, proof) {
      owner.contextReminders.prepared('human', target, proof);
      return undefined;
    },
  });
  let current: ExpectedLaunchMember = {
    memberId: binding.memberId, binding, runtimeGeneration: 1,
    configurationDigest: runtimeDigest('TEST-profile-1'),
    baseConfigurationDigest: runtimeDigest('TEST-base-profile'),
    contextDigest: runtimeDigest('TEST-context'), configRevision: 'TEST-config',
    skipped: false, timeoutMs: 10_000,
  };
  const assertHuman = () => { owner.withLaunchAuthority('human', 'control', () => undefined); };
  const launch = new TeamLaunchOwner({
    definition: { launchId: binding.runId, rosterRevision: human.readRoster().revision, members: [current] },
    hostIncarnation: 'TEST-host', store,
    authorized: (action, callback) => owner.withLaunchAuthority('human', action, callback),
    captureActor: () => ({ principalId: 'human',
      authorityRevision: owner.withLaunchAuthority('human', 'control', revision => revision) }),
    runtime: {
      read() {
        const observed = runtime.readSession(current.binding!);
        return { ...(observed.record ? { record: observed.record } : {}), attached: observed.attached,
          nativeReady: observed.record?.nativeReady === true,
          context: { kind: 'native-configuration', contextDigest: current.contextDigest!,
            generation: current.binding!.generation, configRevision: current.configRevision! } };
      },
      async open(_memberId, assertAuthority) {
        const request = { binding: current.binding!, config: {
          tenantId: teamBinding.backendId, projectId: 'TEST-project',
          sessionId: `TEST-session-${current.runtimeGeneration}`, generation: current.runtimeGeneration!,
          configRevision: current.configRevision!, requiredCapabilities: ['tools'],
        } };
        if (current.runtimeGeneration === 1) await runtime.openSession(request, assertAuthority);
        else await runtime.openFreshMemberSession({ ...request, sourceBinding: binding }, assertHuman);
      },
    },
  });
  t.after(async () => {
    launch.seal();
    for (const session of sessions) session.events.end();
    await tick();
    rmSync(root, { recursive: true, force: true });
  });
  await launch.startMember(binding.memberId);
  const state = () => store.read<OwnerState>('state.json')!;
  const admit = async (commandId: string) => {
    const receipt = human.execute({ commandId, operation: 'message.send',
      payload: { to: 'alice', text: `TEST original ${commandId}`, actionMode: 'ask' } });
    assert.equal(receipt.phase, 'completed');
    const intent = human.pendingDeliveries().find(row => row.messageId === receipt.effects.messageId)!;
    assert.ok(intent);
    await runtime.admitDelivery(intent);
    return intent;
  };
  const restart = async () => {
    const actions = launch.memberActions(), source = actions.source(binding.memberId);
    const input: MemberActionInput = {
      commandId: 'TEST-fresh-restart', launchId: binding.runId, memberId: binding.memberId,
      rosterRevision: launch.read().rosterRevision, expectedGeneration: binding.generation, action: 'restart',
    };
    const selected: ExpectedLaunchMember = { ...source, runtimeGeneration: 2,
      binding: { ...binding, generation: `restart-${runtimeDigest({ commandId: input.commandId, sourceBinding: binding })}` },
      configurationDigest: runtimeDigest('TEST-profile-2') };
    actions.prepare(input, selected);
    const result = await transitionRuntimeMember({
      input, selected, sourceBinding: binding, actions, runtime,
      assertOriginalAuthority: assertHuman,
      assertNewWorkAllowed: () => owner.assertExecutionAllowed('human'),
      retireOriginal: async () => true,
      installSelected() { current = selected; },
      startSelected: () => launch.startMember(binding.memberId, assertHuman, input.commandId),
    });
    assert.equal(result?.phase, 'selected');
    return selected.binding!;
  };
  return { binding, runtime, runtimeStore, sessions, store, state, admit, restart,
    fail: (next: typeof fault) => { fault = next; } };
}

for (const fault of ['second-archive', 'state'] as const) {
  test(`fresh restart reconciles ${fault} interruption before replacing context candidates or claiming new work`, async (t) => {
    const f = await setup(t), originalSession = f.sessions[0]!;
    for (let index = 0; index < 120; index++) originalSession.events.push({
      sessionRef: originalSession.sessionRef, kind: 'compaction',
      sourceRef: `TEST-reset-${index}`, reason: 'automatic',
    });
    await tick();
    assert.equal(f.state().contextEpochs?.length, 120);
    await f.admit('TEST-before-restart');
    f.fail(fault);
    await assert.rejects(f.runtime.dispatchNext(f.binding), /TEST interrupted/);
    const original = structuredClone(f.runtime.readSession(f.binding).record!.inputs[0]!);
    assert.equal(original.phase, 'claimed');
    assert.ok(original.preparation);
    assert.equal(originalSession.submits.length, 0);
    const proof = preparedInputProof(original.preparation);
    const first = f.state().contextEpochs![0]!;
    assert.equal(first.represented, undefined);
    const archivePath = `context-epochs/${first.epochId}.json`;
    const archived = f.store.read<TeamContextEpoch>(archivePath)!;
    assert.deepEqual(archived.represented, proof);

    const next = await f.restart();
    const stopped = f.runtimeStore.fenced(f.binding, tx => tx.get()!);
    assert.equal(stopped.phase, 'closed');
    assert.equal(stopped.custody, 'released');
    assert.equal(stopped.inputs[0]!.phase, 'unknown');
    assert.deepEqual(stopped.inputs[0]!.preparation, original.preparation);
    const intent = await f.admit('TEST-after-restart');
    assert.deepEqual(normalizeBinding(intent.binding), next);
    await assert.doesNotReject(f.runtime.dispatchNext(next));
    const successor = f.runtime.readSession(next).record!.inputs[0]!;
    assert.equal(successor.phase, 'consumed');
    assert.equal(successor.preparation, undefined, 'an already acknowledged old reset is not a new reminder');
    assert.equal(f.sessions[1]!.submits.length, 1);
    assert.equal(f.sessions[1]!.submits[0]!.content, intent.content);
    assert.equal(originalSession.submits.length, 0, 'recovery never retries the original uncertain input');
    assert.deepEqual(f.store.read<TeamContextEpoch>(archivePath), archived);
    assert.equal(f.state().contextEpochs?.length, 0);
    for (const id of proof.epochIds)
      assert.deepEqual(f.store.read<TeamContextEpoch>(`context-epochs/${id}.json`)?.represented, proof);
  });
}

test('129 dispatched compactions retire through both owners and an old duplicate cannot repeat a reminder', async (t) => {
  const f = await setup(t), session = f.sessions[0]!;
  for (let index = 0; index < 129; index++) {
    session.events.push({ sessionRef: session.sessionRef, kind: 'compaction',
      sourceRef: `TEST-reset-${index}`, reason: 'automatic' });
    await tick();
    const intent = await f.admit(`TEST-work-${index}`);
    await f.runtime.dispatchNext(f.binding);
    assert.equal(session.submits.length, index + 1);
    assert.ok(session.submits[index]!.content.endsWith(intent.content));
    session.result(index);
    await tick();
  }
  const before = structuredClone(f.state());
  const record = f.runtime.readSession(f.binding).record!;
  assert.equal(record.contextEpochs?.length, 1);
  assert.equal(record.inputs.flatMap(input => input.representedContextEpochs ?? []).length, 128);
  assert.equal(before.contextEpochs?.length, 1);
  assert.ok(before.contextEpochs![0]!.represented);
  session.events.push({ sessionRef: session.sessionRef, kind: 'compaction',
    sourceRef: 'TEST-reset-0', reason: 'automatic' });
  await tick();
  assert.equal(session.submits.length, 129);
  assert.deepEqual(f.state(), before);
  assert.equal(f.runtime.readSession(f.binding).record!.nativeReady, true);
  const intent = await f.admit('TEST-after-old-duplicate');
  await f.runtime.dispatchNext(f.binding);
  assert.equal(session.submits.length, 130);
  assert.equal(session.submits[129]!.content, intent.content);
  const last = f.runtime.readSession(f.binding).record!.inputs.at(-1)!;
  assert.equal(last.phase, 'consumed');
  assert.equal(last.preparation, undefined);
});
