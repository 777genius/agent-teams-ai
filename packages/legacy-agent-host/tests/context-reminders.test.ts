import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { FileRuntimeEventStorage } from '../dist/adapters/runtime/FileRuntimeEventStorage.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { deliveryFingerprint } from '../dist/runtime/identity.js';
import { preparedInputProof } from '../dist/runtime/inputPreparation.js';
import { readLeadObservation } from '../dist/composition/readLeadObservation.js';
import type { HostedTeam, MemberEntry } from '../dist/composition/MemberEntry.js';
import { ControlledSession } from './context-test-session.ts';
import type { TestContext } from 'node:test';
import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { RuntimeOwnerOptions } from '../dist/runtime/contracts.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function setup(
  t: TestContext,
  failRepresented = false,
  leadOnly = false,
  failObserved = false
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-m10-context-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const teamBinding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-team' };
  const binding = {
    backendId: teamBinding.backendId,
    teamId: teamBinding.teamId,
    runId: 'TEST-run',
    memberId: 'alice-id',
    generation: '1',
  };
  let fail = failRepresented;
  class FaultStore extends TeamOwnerStore {
    override write<T>(name: string, value: T): void {
      if (failObserved && name === 'state.json' && (value as OwnerState).contextEpochs?.length) {
        failObserved = false;
        throw new Error('TEST interrupted pending epoch publication');
      }
      if (
        fail &&
        name === 'state.json' &&
        (value as OwnerState).contextEpochs?.some((row) => row.represented)
      ) {
        fail = false;
        throw new Error('TEST interrupted represented acknowledgement');
      }
      super.write(name, value);
    }
  }
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding: teamBinding,
    store: new FaultStore(root, teamBinding.teamName),
    assertRosterEditable: () => undefined,
    members: [
      ...(leadOnly ? [] : [{ name: 'lead', memberId: 'lead-id', role: 'lead' as const }]),
      {
        name: 'alice',
        memberId: 'alice-id',
        role: leadOnly ? 'lead' : 'member',
        settings: { role: 'TEST current role', workflow: 'TEST current workflow' },
        delivery: { ...binding, teamName: teamBinding.teamName },
      },
    ],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'admin', 'message.write', 'task.write'],
      },
      {
        principalId: 'alice-session',
        memberName: 'alice',
        permissions: ['read', 'task.write', 'message.write'],
      },
    ],
    savedSettings: { cwd: root, prompt: 'TEST standing policy' },
  };
  const owner = createFilesystemTeamOwner(options),
    human = owner.connect('human');
  const store = new FileRuntimeStore(root),
    events = new FileRuntimeEventStorage(root);
  const session = new ControlledSession('TEST-native-session');
  const callbacks: Pick<RuntimeOwnerOptions, 'prepareInput' | 'inputPrepared' | 'contextObserved'> =
    {
      contextObserved(target, epoch) {
        owner.contextReminders.observe('human', target, epoch);
        return undefined;
      },
      prepareInput(target, request) {
        return owner.contextReminders.prepare('human', {
          ...request,
          binding: target,
          workspace: root,
          maxPrefixBytes: 64 * 1024,
        });
      },
      inputPrepared(target, proof) {
        owner.contextReminders.prepared('human', target, proof);
        return undefined;
      },
    };
  const make = (hostIncarnation: string) =>
    new RuntimeOwner({
      store,
      events,
      profileId: 'TEST-profile',
      hostIncarnation,
      driverFactory: { open: async () => ({ driver: session, capabilities: ['tools'] }) },
      canDispatch: () => true,
      authorize: (target, action, intent) =>
        intent
          ? owner.authorizeDeliveryIntent(intent, action)
          : owner.authorizeMemberBinding(target, action),
      ...callbacks,
    });
  const runtime = make('TEST-host-1');
  await runtime.openSession({
    binding,
    config: {
      tenantId: 'TEST-backend',
      projectId: 'TEST-project',
      sessionId: session.sessionRef,
      generation: 1,
      configRevision: 'TEST-config',
      requiredCapabilities: ['tools'],
    },
  });
  t.after(async () => {
    session.events.end();
    await tick();
  });
  const state = () =>
    JSON.parse(
      readFileSync(join(root, 'teams', teamBinding.teamName, '.host-owner', 'state.json'), 'utf8')
    ) as OwnerState;
  async function compact() {
    session.events.push({
      sessionRef: session.sessionRef,
      kind: 'compaction',
      sourceRef: 'TEST-compact-epoch',
      reason: 'automatic',
    });
    await tick();
    assert.equal(state().contextEpochs?.length, 1);
  }
  async function admit(commandId: string) {
    const receipt = human.execute({
      commandId,
      operation: 'message.send',
      payload: { to: 'alice', text: 'TEST original user work', actionMode: 'ask' },
    });
    assert.equal(receipt.phase, 'completed');
    const intent = human
      .pendingDeliveries()
      .find((row) => row.messageId === receipt.effects.messageId)!;
    assert.ok(intent);
    await runtime.admitDelivery(intent);
    return intent;
  }
  return {
    root,
    binding,
    owner,
    human,
    runtime,
    session,
    store,
    state,
    compact,
    admit,
    make,
    options,
  };
}

test('duplicate compaction stays pending without native turn; next original input contains current Team policy exactly once', async (t) => {
  const f = await setup(t);
  await f.compact();
  await f.compact();
  assert.equal(f.session.submits.length, 0);
  assert.equal(f.state().contextEpochs?.[0]?.represented, undefined);
  f.human.execute({
    commandId: 'TEST-new-task',
    operation: 'task.create',
    payload: { subject: 'TEST current board after compaction' },
  });
  const intent = await f.admit('TEST-original-message'),
    fingerprint = deliveryFingerprint(intent);
  await f.runtime.dispatchNext(f.binding);
  const record = f.runtime.readSession(f.binding).record!,
    input = record.inputs[0]!,
    submitted = f.session.submits[0]!;
  assert.equal(record.inputs.length, 1);
  assert.equal(f.session.submits.length, 1);
  assert.equal(input.fingerprint, fingerprint);
  assert.equal(input.intent.content, intent.content);
  assert.equal(submitted.inputId, intent.inputId);
  assert.equal(submitted.operationRef, input.operationRef);
  assert.ok(submitted.content.includes('TEST current role'));
  assert.ok(submitted.content.includes('TEST current board after compaction'));
  assert.ok(submitted.content.includes('TEST current workflow'));
  assert.ok(submitted.content.includes('TEST standing policy'));
  assert.ok(submitted.content.endsWith(intent.content));
  assert.equal(input.preparation!.nativePayloadHash, sha(submitted.content));
  assert.equal(input.preparation!.prefixHash, sha(input.preparation!.prefix));
  assert.deepEqual(
    f.state().contextEpochs![0]!.represented,
    preparedInputProof(input.preparation!)
  );
  f.session.result();
  await tick();
  const second = await f.admit('TEST-second-original-message');
  await f.runtime.dispatchNext(f.binding);
  assert.equal(
    f.session.submits[1]!.content,
    second.content,
    'represented epoch must not add a second reminder'
  );
  assert.equal(f.state().contextEpochs?.length, 1);
});

test('uncertain native handoff retains exact prepared input across cold owner restart without retry', async (t) => {
  const f = await setup(t);
  await f.compact();
  const intent = await f.admit('TEST-uncertain');
  f.session.submitAction = async () => {
    throw new Error('TEST unknown handoff');
  };
  await f.runtime.dispatchNext(f.binding);
  const before = f.runtime.readSession(f.binding).record!.inputs[0]!;
  assert.equal(before.phase, 'unknown');
  assert.ok(before.preparation);
  const restarted = f.make('TEST-host-2');
  assert.equal((await restarted.lookupDelivery(intent)).outcome, 'admitted');
  await assert.rejects(restarted.dispatchNext(f.binding));
  assert.equal(f.session.submits.length, 1);
  assert.deepEqual(
    restarted.readSession(f.binding).record!.inputs[0]!.preparation,
    before.preparation
  );
  assert.ok(createFilesystemTeamOwner(f.options).contextReminders);
});

test('interrupted Team acknowledgement is repaired only from original durable claimed preparation, without handoff', async (t) => {
  const f = await setup(t, true);
  await f.compact();
  await f.admit('TEST-interrupted-ack');
  await assert.rejects(f.runtime.dispatchNext(f.binding), /TEST interrupted/);
  const input = f.runtime.readSession(f.binding).record!.inputs[0]!;
  assert.equal(input.phase, 'claimed');
  assert.ok(input.preparation);
  assert.equal(f.session.submits.length, 0);
  assert.equal(f.state().contextEpochs![0]!.represented, undefined);
  const coldTeam = createFilesystemTeamOwner(f.options);
  const selected = coldTeam.contextReminders.prepare('human', {
    binding: f.binding,
    sessionRef: f.session.sessionRef,
    inputId: 'TEST-later-input',
    operationRef: 'TEST-later-op',
    intentFingerprint: 'a'.repeat(64),
    workspace: f.root,
    maxPrefixBytes: 64 * 1024,
    epochs: [],
    priorProofs: [preparedInputProof(input.preparation!)],
  });
  assert.equal(selected, undefined);
  assert.deepEqual(
    f.state().contextEpochs![0]!.represented,
    preparedInputProof(input.preparation!)
  );
  await assert.rejects(f.runtime.dispatchNext(f.binding));
  assert.equal(f.session.submits.length, 0);
});

test('revocation prevents prefix preparation and native publication', async (t) => {
  const f = await setup(t);
  await f.compact();
  await f.admit('TEST-revoked');
  f.human.revoke('alice-session');
  await assert.rejects(f.runtime.dispatchNext(f.binding));
  assert.equal(f.session.submits.length, 0);
  assert.equal(
    f.store.fenced(f.binding, (tx) => tx.get()!.inputs[0]!.preparation),
    undefined
  );
});

test('native preparation tampering is rejected by the real durable Runtime store', async (t) => {
  const f = await setup(t);
  await f.compact();
  await f.admit('TEST-tamper');
  await f.runtime.dispatchNext(f.binding);
  const before = f.store.fenced(f.binding, (tx) => tx.get()!);
  const changed = structuredClone(before);
  changed.inputs[0]!.preparation!.prefix += 'TEST altered prefix';
  assert.throws(() => f.store.fenced(f.binding, (tx) => tx.put(changed)));
  assert.deepEqual(
    f.store.fenced(f.binding, (tx) => tx.get()!),
    before
  );
  assert.equal(f.session.submits.length, 1);
});

test('a pending Team epoch survives a supported roster recapture and reads new role without adopting old native identity', async (t) => {
  const f = await setup(t);
  await f.compact();
  const source = f.state().contextEpochs![0]!;
  await f.runtime.stopSession(f.binding);
  f.human.replaceRoster({
    commandId: 'TEST-new-roster',
    expectedRevision: f.human.readRoster().revision,
    members: [
      {
        name: 'alice',
        role: 'TEST role changed after compaction',
        workflow: 'TEST changed workflow',
      },
    ],
  });
  const roster = f.human.readRoster();
  const next = { ...f.binding, runId: 'TEST-new-launch', generation: '2' };
  f.owner.registerRuntime('human', {
    commandId: 'TEST-recapture',
    expectedRevision: roster.revision,
    launchId: 'TEST-new-launch',
    members: roster.members.map((member) => ({
      memberId: member.memberId,
      principalId: `TEST-new-${member.name}`,
      delivery: { ...next, memberId: member.memberId, teamName: 'test-team' },
    })),
  });
  const prepared = f.owner.contextReminders.prepare('human', {
    binding: next,
    sessionRef: 'TEST-new-native-session',
    inputId: 'TEST-next-original',
    operationRef: 'TEST-next-operation',
    intentFingerprint: 'a'.repeat(64),
    epochs: [],
    priorProofs: [],
    workspace: f.root,
    maxPrefixBytes: 64 * 1024,
  });
  assert.ok(prepared?.prefix.includes('TEST role changed after compaction'));
  assert.ok(prepared?.prefix.includes('TEST changed workflow'));
  assert.deepEqual(prepared?.epochIds, [source.epochId]);
  assert.deepEqual(f.state().contextEpochs![0]!.binding, source.binding);
  assert.deepEqual(f.state().contextEpochs![0]!.candidate!.binding, next);
  assert.equal(
    f.state().contextEpochs![0]!.represented,
    undefined,
    'a Team candidate is not a durable native input preparation proof'
  );
  assert.equal(f.session.submits.length, 0);
});

test('Lead views use the current exact captured session, clear old usage after compaction and refuse stale custody', async (t) => {
  const f = await setup(t, false, true);
  const team: HostedTeam = {
    owner: f.owner,
    connection: f.human,
    definition: {
      binding: f.options.binding,
      members: f.options.members,
      grants: f.options.grants,
      scope: {
        projectId: 'TEST-project',
        workspaceId: 'TEST-workspace',
        teamId: 'TEST-team',
        runId: 'TEST-run',
        memberId: 'lead-id',
        generation: '1',
      },
    },
  };
  const entry = { binding: f.binding, team } as MemberEntry;
  let current = true;
  const options = {
    team,
    principalId: 'human',
    entries: [entry],
    runtime: f.runtime,
    launch: { launchId: 'TEST-launch', rosterRevision: f.human.readRoster().revision },
    isCurrent: () => current,
    assertCurrent: () => undefined,
  };
  assert.equal((readLeadObservation(options, 'activity') as { state: string }).state, 'idle');
  await f.admit('TEST-lead-work');
  await f.runtime.dispatchNext(f.binding);
  assert.equal((readLeadObservation(options, 'activity') as { state: string }).state, 'active');
  const input = f.session.submits[0]!;
  f.session.events.push({
    sessionRef: f.session.sessionRef,
    inputId: input.inputId,
    operationRef: input.operationRef,
    kind: 'usage',
    inputTokens: 99,
    outputTokens: 12,
  });
  await tick();
  const usage = (
    readLeadObservation(options, 'context') as {
      usage: {
        outputTokens: number;
        promptInputTokens: null;
        contextUsedTokens: null;
        contextUsedPercent: null;
        updatedAt: string;
      };
    }
  ).usage;
  assert.equal(usage.outputTokens, 12);
  assert.equal(usage.promptInputTokens, null);
  assert.equal(usage.contextUsedTokens, null);
  assert.equal(usage.contextUsedPercent, null);
  assert.ok(Number.isFinite(Date.parse(usage.updatedAt)));
  f.session.result();
  await tick();
  await f.compact();
  assert.equal((readLeadObservation(options, 'context') as { usage: unknown }).usage, null);
  current = false;
  assert.throws(() => readLeadObservation(options, 'activity'));
  current = true;
  await f.runtime.stopSession(f.binding);
  assert.deepEqual(readLeadObservation(options, 'activity'), {
    kind: 'team-lead-activity',
    state: 'offline',
    launch: null,
  });
});

test('compaction during an active original input waits for ordinary terminal admission before folding into the next input', async (t) => {
  const f = await setup(t);
  const first = await f.admit('TEST-active-original');
  await f.runtime.dispatchNext(f.binding);
  await f.compact();
  const second = await f.admit('TEST-next-after-compact');
  await assert.rejects(f.runtime.dispatchNext(f.binding));
  assert.equal(f.session.submits.length, 1);
  assert.equal(f.state().contextEpochs![0]!.candidate, undefined);
  f.session.result(0);
  await tick();
  await f.runtime.dispatchNext(f.binding);
  assert.equal(f.session.submits.length, 2);
  assert.equal(f.session.submits[0]!.inputId, first.inputId);
  assert.equal(f.session.submits[1]!.inputId, second.inputId);
  assert.ok(f.session.submits[1]!.content.endsWith(second.content));
  assert.ok(f.state().contextEpochs![0]!.represented);
});

test('Lead read refuses disclosure when Team authority is revoked during captured observation collection', async (t) => {
  const f = await setup(t, false, true);
  const team: HostedTeam = {
    owner: f.owner,
    connection: f.human,
    definition: {
      binding: f.options.binding,
      members: f.options.members,
      grants: f.options.grants,
      scope: {
        projectId: 'TEST-project',
        workspaceId: 'TEST-workspace',
        teamId: 'TEST-team',
        runId: 'TEST-run',
        memberId: 'lead-id',
        generation: '1',
      },
    },
  };
  const entry = { binding: f.binding, team } as MemberEntry;
  assert.throws(() =>
    readLeadObservation(
      {
        team,
        principalId: 'human',
        entries: [entry],
        runtime: {
          readCapturedSession: (binding) => f.runtime.readCapturedSession(binding),
          readActivitySnapshot: (binding) => {
            const snapshot = f.runtime.readActivitySnapshot(binding);
            f.human.revoke('human');
            return snapshot;
          },
        },
        launch: { launchId: 'TEST-launch', rosterRevision: f.human.readRoster().revision },
        isCurrent: () => true,
        assertCurrent: () => undefined,
      },
      'context'
    )
  );
  assert.equal(f.session.submits.length, 0);
});

test('failed Team pending publication retains the exact technical epoch and holds native work for cold repair', async (t) => {
  const f = await setup(t, false, false, true);
  f.session.events.push({
    sessionRef: f.session.sessionRef,
    kind: 'compaction',
    sourceRef: 'TEST-publication-failure',
    reason: 'automatic',
  });
  await tick();
  const record = f.store.fenced(f.binding, (tx) => tx.get()!);
  assert.equal(record.contextEpochs?.length, 1);
  assert.equal(record.nativeReady, false);
  assert.equal(record.diagnostic, 'observe-failed');
  assert.equal(f.state().contextEpochs, undefined);
  await f.admit('TEST-source-hold');
  await assert.rejects(f.runtime.dispatchNext(f.binding));
  const cold = createFilesystemTeamOwner(f.options);
  const prepared = cold.contextReminders.prepare('human', {
    binding: f.binding,
    sessionRef: f.session.sessionRef,
    inputId: 'TEST-repair-only',
    operationRef: 'TEST-repair-op',
    intentFingerprint: 'a'.repeat(64),
    epochs: record.contextEpochs!,
    priorProofs: [],
    workspace: f.root,
    maxPrefixBytes: 64 * 1024,
  });
  assert.deepEqual(prepared?.epochIds, [record.contextEpochs![0]!.epochId]);
  assert.equal(f.state().contextEpochs![0]!.represented, undefined);
  assert.equal(f.session.submits.length, 0);
});
