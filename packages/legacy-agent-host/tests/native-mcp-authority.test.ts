import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { captureNativeInputAuthority } from '../dist/composition/captureNativeInputAuthority.js';
import { deliveryFingerprint, runtimeDigest } from '../dist/runtime/identity.js';
import type { RuntimeDelivery, RuntimeSessionRecord } from '../dist/runtime/contracts.js';

function fixture(t: TestContext, role: 'lead' | 'member' = 'lead') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-mcp-authority-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-native-mcp' };
  const source = {
    backendId: binding.backendId,
    teamId: binding.teamId,
    runId: 'TEST-run',
    memberId: 'actual-agent-id',
    generation: '1',
  };
  const owner = createFilesystemTeamOwner({
    root,
    binding,
    members: [
      {
        memberId: source.memberId,
        name: 'alice',
        role,
        delivery: { ...source, teamName: binding.teamName },
      },
      ...(role === 'member'
        ? [{ memberId: 'actual-lead-id', name: 'leader', role: 'lead' as const }]
        : []),
    ],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'task.write', 'message.write', 'admin'],
      },
      {
        principalId: 'native-connection',
        memberName: 'alice',
        permissions: ['read', 'task.write', 'message.write'],
      },
    ],
  });
  const human = owner.connect('human');
  for (const actionMode of role === 'lead'
    ? (['do', 'ask', 'delegate'] as const)
    : (['do', 'ask'] as const))
    human.execute({
      commandId: `TEST-${actionMode}`,
      operation: 'message.send',
      payload: { to: 'alice', text: `TEST original ${actionMode}`, actionMode },
    });
  function input(mode: string) {
    const raw = human.pendingDeliveries().find((intent) => intent.commandId === `TEST-${mode}`);
    assert.ok(raw);
    return raw;
  }
  const config: NonNullable<RuntimeSessionRecord['config']> = {
    tenantId: 'TEST-backend',
    projectId: 'TEST-project',
    sessionId: 'TEST-session',
    generation: 1,
    configRevision: 'TEST-config',
    requiredCapabilities: ['tools'],
  };
  const initial = input('do');
  let record: RuntimeSessionRecord = {
    schemaVersion: 1,
    binding: source,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config,
    openFingerprint: runtimeDigest({ profileId: 'TEST-profile', config }),
    phase: 'allocated',
    sealed: false,
    custody: 'owned',
    nativeReady: true,
    sessionRef: 'TEST-session-ref',
    inputs: [
      {
        intent: initial,
        fingerprint: deliveryFingerprint(initial),
        operationRef: 'TEST-operation-DO',
        phase: 'consumed',
      },
    ],
    interactions: [],
  };
  let attached = true;
  const options = {
    binding: source,
    profileId: record.profileId,
    hostIncarnation: record.hostIncarnation,
    config,
    readRuntime: () => ({ record, attached }),
    captureTeam: (raw: RuntimeDelivery) =>
      owner.captureNativeMcpAuthority('native-connection', source, raw, true),
    assertCurrent() {},
  };
  return {
    owner,
    human,
    source,
    input,
    options,
    get record() {
      return record;
    },
    set record(next: RuntimeSessionRecord) {
      record = next;
    },
    detach() {
      attached = false;
    },
  };
}

test('actual persisted original input and authenticated member grant authorize DO only; human/payload/mode substitution is refused', (t) => {
  const f = fixture(t);
  const authority = captureNativeInputAuthority(f.options);
  assert.equal(authority.team.principalId, 'native-connection');
  assert.equal(authority.team.actorId, 'actual-agent-id');
  assert.equal(authority.team.memberName, 'alice');
  assert.ok(Object.isFrozen(authority.team.cause.binding));
  for (const mode of ['ask', 'delegate'])
    assert.throws(
      () => f.owner.captureNativeMcpAuthority('native-connection', f.source, f.input(mode), true),
      /forbidden/
    );
  assert.throws(
    () => f.owner.captureNativeMcpAuthority('human', f.source, f.input('do'), true),
    /forbidden/
  );
  assert.throws(
    () =>
      f.owner.captureNativeMcpAuthority(
        'native-connection',
        f.source,
        { ...f.input('do'), content: 'TEST forged payload' },
        true
      ),
    /forbidden|hold/
  );
});

test('after await original input cannot retarget a later input, changed native session/config, duplicate active input or closed custody', async (t) => {
  const f = fixture(t);
  const authority = captureNativeInputAuthority(f.options);
  await Promise.resolve();
  const original = structuredClone(f.record);
  const next = f.input('ask');
  f.record.inputs = [
    {
      intent: next,
      fingerprint: deliveryFingerprint(next),
      operationRef: 'TEST-operation-ASK',
      phase: 'consumed',
    },
  ];
  assert.throws(authority.assertCurrent, /forbidden/);
  f.record = structuredClone(original);
  f.record.sessionRef = 'TEST-new-session';
  assert.throws(authority.assertCurrent, /forbidden/);
  f.record = structuredClone(original);
  f.record.config = { ...f.record.config!, configRevision: 'TEST-new-config' };
  assert.throws(authority.assertCurrent, /hold/);
  f.record = structuredClone(original);
  f.record.inputs.push(structuredClone(f.record.inputs[0]!));
  assert.throws(authority.assertCurrent, /hold/);
  f.record = structuredClone(original);
  f.record.inputs[0]!.phase = 'terminal';
  assert.throws(authority.assertCurrent, /hold/);
  f.record = structuredClone(original);
  f.record.custody = 'released';
  assert.throws(authority.assertCurrent, /hold/);
  f.record = structuredClone(original);
  f.detach();
  assert.throws(authority.assertCurrent, /hold/);
});

test('grant revocation and non-lead cannot borrow an earlier captured DO proof', async (t) => {
  const f = fixture(t);
  const authority = captureNativeInputAuthority(f.options);
  await Promise.resolve();
  f.human.revoke('native-connection');
  assert.throws(authority.assertCurrent, /forbidden/);
  const member = fixture(t, 'member');
  assert.throws(() => captureNativeInputAuthority(member.options), /forbidden/);
  const own = member.owner.captureNativeMcpAuthority(
    'native-connection',
    member.source,
    member.input('do'),
    false
  );
  assert.equal(own.role, 'member');
});

test('original WorkSync command family replays completed result once and rejects another native input or product command collision', async (t) => {
  const f = fixture(t);
  const authority = captureNativeInputAuthority(f.options);
  const commands = f.owner.workSyncCommands('native-connection');
  let calls = 0;
  const effect = async () => {
    calls++;
    return { accepted: true };
  };
  assert.deepEqual(
    await commands.execute(
      'TEST-work-sync-command',
      'report',
      { state: 'caught_up' },
      authority,
      effect
    ),
    { accepted: true }
  );
  const first = commands.lookup('TEST-work-sync-command');
  assert.ok(first);
  assert.equal(first.inputAuthority, authority.fingerprint);
  assert.deepEqual(
    await commands.execute(
      'TEST-work-sync-command',
      'report',
      { state: 'caught_up' },
      authority,
      effect
    ),
    { accepted: true }
  );
  assert.equal(calls, 1);
  assert.deepEqual(commands.lookup('TEST-work-sync-command'), first);
  assert.throws(
    () =>
      f.human.execute({
        commandId: 'TEST-work-sync-command',
        operation: 'task.create',
        payload: { subject: 'TEST must not cross receipt family' },
      }),
    /conflict|hold/
  );
  f.human.execute({
    commandId: 'TEST-second-do',
    operation: 'message.send',
    payload: { to: 'alice', text: 'TEST second DO', actionMode: 'do' },
  });
  const next = f.human.pendingDeliveries().find((row) => row.commandId === 'TEST-second-do');
  assert.ok(next);
  f.record.inputs = [
    {
      intent: next,
      fingerprint: deliveryFingerprint(next),
      operationRef: 'TEST-second-operation',
      phase: 'consumed',
    },
  ];
  const later = captureNativeInputAuthority(f.options);
  assert.notEqual(later.fingerprint, authority.fingerprint);
  await assert.rejects(
    commands.execute('TEST-work-sync-command', 'report', { state: 'caught_up' }, later, effect),
    /conflict/
  );
  assert.equal(calls, 1);
});

test('post-await replacement input leaves original running receipt held without re-executing its uncertain effect', async (t) => {
  const f = fixture(t);
  const authority = captureNativeInputAuthority(f.options);
  const commands = f.owner.workSyncCommands('native-connection');
  let calls = 0;
  await assert.rejects(
    commands.execute('TEST-held-work-sync', 'status', {}, authority, async () => {
      calls++;
      await Promise.resolve();
      const next = f.input('ask');
      f.record.inputs = [
        {
          intent: next,
          fingerprint: deliveryFingerprint(next),
          operationRef: 'TEST-next-ask',
          phase: 'consumed',
        },
      ];
      return { state: 'TEST never publish under next input' };
    }),
    /forbidden/
  );
  const original = commands.lookup('TEST-held-work-sync');
  assert.equal(original?.phase, 'running');
  assert.equal(original?.result, undefined);
  assert.equal(calls, 1);
  await assert.rejects(
    commands.execute('TEST-held-work-sync', 'status', {}, authority, async () => {
      calls++;
      return {};
    }),
    /forbidden/
  );
  assert.equal(calls, 1);
  assert.deepEqual(commands.lookup('TEST-held-work-sync'), original);
});
