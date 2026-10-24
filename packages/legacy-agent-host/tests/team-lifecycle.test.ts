import { TeamOwner } from '../dist/team/TeamOwner.js';
import { createTeamPolicy } from '../dist/adapters/team/ControllerAdapter.js';
import { TaskEffectPlan } from '../dist/adapters/team/TaskEffectPlan.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { continueTeamLifecycleCleanup } from '../dist/team/continueTeamLifecycleCleanup.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamRosterTransitions } from '../dist/team/TeamRosterTransitions.js';
import { TeamLifecycleTransitions } from '../dist/team/TeamLifecycleTransitions.js';
import type { LifecycleOwnerState } from '../dist/team/lifecycleContracts.js';
import type { TeamGrant } from '../dist/team/contracts.js';

function fixture(t: import('node:test').TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-lifecycle-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const members = [{ memberId: 'TEST-lead', name: 'team-lead', role: 'lead' as const }];
  const grants: TeamGrant[] = [{ principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'admin'] }];
  const owner = createFilesystemTeamOwner({ root, binding, store, members, grants });
  owner.connect('human').execute({ commandId: 'TEST-task', operation: 'task.create', payload: { subject: 'retained task' } });
  const state = () => store.read<LifecycleOwnerState>('state.json')!;
  const authorize = (principalId: string, permission: 'admin' | 'read') => {
    const grant = state().grants.find(row => row.principalId === principalId);
    if (!grant || grant.revoked || !grant.permissions.includes(permission)) throw new Error('forbidden');
    return grant;
  };
  const roster = new TeamRosterTransitions({ binding, store, state, authorize, assertEditable() {}, invalidate() {} });
  const lifecycle = new TeamLifecycleTransitions({ binding, store, state, authorize, captureRuntimeBindings: () => [],
    recoverConfig: current => roster.recover(current), invalidate() {}, reserved: id => !!store.read(`commands/${id}.json`) });
  return { root, store, owner, state, lifecycle };
}
test('trash/restore is one original product decision; restore retains Task bytes and grants, and does not clear runtime debt', t => {
  const f = fixture(t), current = f.lifecycle.view('human');
  const tasksBefore = f.owner.connect('human').listTasks();
  const grants = structuredClone(f.state().grants);
  const input = { commandId: 'TEST-trash', operation: 'trash', expectedRevision: current.revision };
  const receipt = f.lifecycle.execute('human', input);
  assert.equal(receipt.phase, 'completed');
  assert.equal(f.lifecycle.view('human').deleted, true);
  assert.equal(f.lifecycle.view('human').cleanupPending, true);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'teams/TEST-team/config.json'), 'utf8')).deletedAt, receipt.after.deletedAt);
  assert.deepEqual(f.lifecycle.execute('human', input), receipt);
  f.lifecycle.execute('human', { commandId: 'TEST-restore', operation: 'restore', expectedRevision: f.lifecycle.view('human').revision });
  assert.equal(f.lifecycle.view('human').deleted, false);
  assert.equal(f.lifecycle.view('human').cleanupPending, true, 'restore does not resume or forgive unknown cleanup');
  assert.deepEqual(f.owner.connect('human').listTasks(), tasksBefore);
  assert.deepEqual(f.state().grants, grants);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'teams/TEST-team/config.json'), 'utf8')).deletedAt, undefined);
});
test('crash after owner tombstone commit recovers original config/receipt without another product decision', t => {
  const f = fixture(t);
  const original = f.store.write.bind(f.store);
  let failed = false;
  f.store.write = (name, value) => {
    if (name === '../config.json' && !failed) { failed = true; throw new Error('TEST publication failure'); }
    original(name, value);
  };
  assert.throws(() => f.lifecycle.execute('human', { commandId: 'TEST-crash-trash', operation: 'trash', expectedRevision: f.lifecycle.view('human').revision }), /publication/);
  const deletedAt = f.state().lifecycle!.deletedAt;
  f.store.write = original;
  f.lifecycle.recover();
  assert.equal(f.state().lifecycle!.deletedAt, deletedAt);
  assert.equal(f.lifecycle.view('human').deleted, true);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'teams/TEST-team/config.json'), 'utf8')).deletedAt, deletedAt);
});
test('original owner admission closes on trash and remains closed after restore until exact cleanup, while read and receipt replay survive', t => {
  const f = fixture(t), api = f.owner.lifecycleCommands('human');
  const input = { commandId: 'TEST-owned-trash', operation: 'trash', expectedRevision: api.view().revision };
  const receipt = api.execute(input);
  assert.throws(() => f.owner.connect('human').execute({ commandId: 'TEST-after-trash', operation: 'task.create', payload: { subject: 'must not publish' } }));
  assert.equal(f.owner.connect('human').listTasks().length, 1);
  assert.deepEqual(api.execute(input), receipt, 'same original lifecycle receipt remains replayable');
  api.execute({ commandId: 'TEST-owned-restore', operation: 'restore', expectedRevision: api.view().revision });
  assert.throws(() => f.owner.connect('human').execute({ commandId: 'TEST-after-restore', operation: 'task.create', payload: { subject: 'must not publish' } }));
  f.owner.lifecycleContinuation().settleCleanup('TEST-owned-trash', original => {
    assert.equal(original.targets.length, 0); assert.equal(original.runtimeBindings.length, 0);
  });
  f.owner.connect('human').execute({ commandId: 'TEST-after-cleanup', operation: 'task.create', payload: { subject: 'new explicit task' } });
  assert.equal(f.owner.connect('human').listTasks().length, 2);
});
test('revocation preserves only the exact original trash cancellation scope, never a new input', t => {
  const f = fixture(t);
  const intent = { schemaVersion: 1 as const, binding: { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team', runId: 'TEST-run', memberId: 'TEST-lead', generation: '1' },
    commandId: 'TEST-original-message', principalId: 'human', authorityRevision: 1,
    messageId: 'TEST-inbox', deliveryId: 'TEST-input', inputId: 'TEST-input', content: 'retained input', phase: 'pending' as const };
  f.store.fenced(() => f.store.write('outbox/TEST-input.json', intent));
  const api = f.owner.lifecycleCommands('human');
  api.execute({ commandId: 'TEST-revoked-trash', operation: 'trash', expectedRevision: api.view().revision });
  f.store.fenced(() => { const state = f.state(); state.grants[0]!.revoked = true; f.store.write('state.json', state); });
  assert.equal(f.owner.authorizeDeliveryIntent(intent, 'control'), true);
  assert.equal(f.owner.authorizeDeliveryIntent(intent, 'read'), true);
  assert.equal(f.owner.authorizeDeliveryIntent(intent, 'admit'), false);
  assert.equal(f.owner.authorizeDeliveryIntent(intent, 'dispatch'), false);
  assert.equal(f.owner.authorizeDeliveryIntent({ ...intent, content: 'replacement payload' }, 'control'), false);
  assert.equal(f.owner.authorizeDeliveryIntent({ ...intent, inputId: 'TEST-other', deliveryId: 'TEST-other' }, 'control'), false);
});
test('actual Runtime store receives original cancellation tombstones after revoke; latest unknown custody holds restored execution', async t => {
  const f = fixture(t);
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', runId: 'TEST-run', memberId: 'TEST-lead', generation: '1' };
  const intent = { schemaVersion: 1 as const, binding: { ...binding, teamName: 'TEST-team' }, commandId: 'TEST-original-message', principalId: 'human', authorityRevision: 1,
    messageId: 'TEST-inbox', deliveryId: 'TEST-input', inputId: 'TEST-input', content: 'retained input', phase: 'pending' as const };
  f.store.fenced(() => {
    const state = f.state(); state.members[0]!.delivery = intent.binding; f.store.write('state.json', state);
    f.store.write('outbox/TEST-input.json', intent);
  });
  const api = f.owner.lifecycleCommands('human');
  api.execute({ commandId: 'TEST-actual-cleanup', operation: 'trash', expectedRevision: api.view().revision });
  api.execute({ commandId: 'TEST-restored-before-cleanup', operation: 'restore', expectedRevision: api.view().revision });
  f.store.fenced(() => { const state = f.state(); state.grants[0]!.revoked = true; f.store.write('state.json', state); });
  let opens = 0;
  const runtime = new RuntimeOwner({ store: new FileRuntimeStore(f.root), profileId: 'TEST-profile', hostIncarnation: 'TEST-incarnation',
    driverFactory: { async open() { opens++; throw new Error('No native input or provider needed for cleanup'); } },
    authorize: (selected, action, input) => input ? f.owner.authorizeDeliveryIntent(input, action) : f.owner.authorizeMemberBinding(selected, action),
    canDispatch: () => false });
  const delivery = { fingerprintDelivery: runtime.fingerprintDelivery.bind(runtime), admitDelivery: runtime.admitDelivery.bind(runtime), lookupDelivery: runtime.lookupDelivery.bind(runtime), cancelDelivery: runtime.cancelDelivery.bind(runtime) };
  const options = { commandId: 'TEST-actual-cleanup', lifecycle: f.owner.lifecycleContinuation(), store: f.store, runtime, delivery };
  let unknown = true, unresolved = false;
  const observing = { stopCapturedSession: runtime.stopCapturedSession.bind(runtime), readCapturedSession(selected: typeof binding) {
    const value = runtime.readCapturedSession(selected);
    return value.record ? { ...value, record: { ...value.record,
      ...(unknown ? { custody: 'unknown' as const } : {}),
      ...(unresolved ? { inputs: value.record.inputs.map(input => ({ ...input, phase: 'unknown' as const })) } : {}),
    } } : value;
  } };
  assert.deepEqual(await continueTeamLifecycleCleanup({ ...options, runtime: observing }), { cleanupPending: true });
  assert.equal(f.state().lifecycle!.cleanupPending, true);
  const cancelled = runtime.readCapturedSession(binding).record!;
  assert.equal(cancelled.phase, 'closed'); assert.equal(cancelled.inputs[0]!.phase, 'cancelled');
  const operationRef = cancelled.inputs[0]!.operationRef;
  unknown = false; unresolved = true;
  assert.deepEqual(await continueTeamLifecycleCleanup({ ...options, runtime: observing }), { cleanupPending: true }, 'released custody cannot conceal unresolved original input debt');
  unresolved = false;
  assert.deepEqual(await continueTeamLifecycleCleanup({ ...options, runtime: {
    readCapturedSession: runtime.readCapturedSession.bind(runtime),
    async stopCapturedSession(selected) { await runtime.stopCapturedSession(selected); throw new Error('TEST-provider-cleanup-held'); },
  } }), { cleanupPending: true }, 'released Runtime record cannot forgive failed original provider/endpoint cleanup');
  assert.deepEqual(await continueTeamLifecycleCleanup(options), { cleanupPending: false });
  assert.equal(runtime.readCapturedSession(binding).record!.inputs[0]!.operationRef, operationRef, 'same input tombstone retained');
  assert.equal(opens, 0);
  assert.equal(f.store.read<{ content: string }>('outbox/TEST-input.json')!.content, intent.content);
});
test('one launch-owned member transition closes only its new-work admission and preserves peer work/read/control', t => {
  const f = fixture(t);
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const a = { ...binding, runId: 'TEST-run', memberId: 'alice', generation: '1' };
  const b = { ...a, memberId: 'bob' };
  f.store.fenced(() => {
    const state = f.state();
    for (const delivery of [a, b]) {
      state.members.push({ memberId: delivery.memberId, name: delivery.memberId, role: 'member', delivery });
      state.grants.push({ principalId: delivery.memberId, memberName: delivery.memberId, permissions: ['read', 'message.write'], revision: 1 });
    }
    f.store.write('state.json', state);
  });
  let workAllowed = false, successor = false;
  const owner = new TeamOwner({ binding, store: f.store, members: [], grants: [],
    policy: createTeamPolicy(f.root, binding.teamName), taskMutations: new TaskEffectPlan(f.root, binding.teamName, f.store), runtimeBindings: {
    current: initial => ({ binding: successor && initial.memberId === 'alice' ? { ...initial, generation: '2' } : initial, generation: 1, configurationDigest: 'TEST-config', baseConfigurationDigest: 'TEST-config',
      workAllowed: initial.memberId === 'alice' ? workAllowed : true }), retained: () => false,
  } });
  for (const action of ['admit', 'dispatch'] as const) {
    assert.equal(owner.authorizeMemberBinding(a, action), false);
    assert.equal(owner.authorizeMemberBinding(b, action), true);
  }
  for (const action of ['read', 'control'] as const) assert.equal(owner.authorizeMemberBinding(a, action), true);
  workAllowed = true;
  assert.equal(owner.authorizeMemberBinding(a, 'admit'), true);
  successor = true;
  const lifecycle = owner.lifecycleCommands('human');
  const trash = lifecycle.execute({ commandId: 'TEST-transition-trash', operation: 'trash', expectedRevision: lifecycle.view().revision });
  assert.equal(f.state().members.find(row => row.name === 'alice')!.delivery!.generation, '1', 'lifecycle must preserve the original launch-owned binding root');
  assert.equal(trash.runtimeBindings.some(row => row.memberId === 'alice' && row.generation === '2'), true);
  assert.throws(() => owner.assertExecutionAllowed('human'));
  assert.equal(owner.authorizeMemberBinding(a, 'admit'), false, 'clean member transition cannot override Team trash');
  assert.equal(owner.authorizeMemberBinding(b, 'dispatch'), false);
  assert.equal(owner.authorizeMemberBinding({ ...a, generation: '2' }, 'control'), true);
});
test('durable trash receipt closes new work even when the first owner-state publication fails', t => {
  const f = fixture(t), api = f.owner.lifecycleCommands('human');
  const input = { commandId: 'TEST-failed-state', operation: 'trash', expectedRevision: api.view().revision };
  const original = f.store.write.bind(f.store);
  let fail = true;
  f.store.write = (name, value) => { if (name === 'state.json' && fail) throw new Error('TEST state publication failed'); original(name, value); };
  assert.throws(() => api.execute(input), /state publication/);
  assert.equal(f.state().lifecycle, undefined, 'business state has not published yet');
  assert.throws(() => f.owner.assertExecutionAllowed('human'), 'prepared original receipt must prevent uncaptured late work');
  assert.throws(() => f.owner.connect('human').execute({ commandId: 'TEST-late-create', operation: 'task.create', payload: { subject: 'must not escape original capture' } }));
  fail = false;
  f.store.write = original;
  f.owner.lifecycleContinuation().recover();
  assert.equal(api.execute(input).phase, 'completed');
  assert.equal(api.view().deleted, true);
});
