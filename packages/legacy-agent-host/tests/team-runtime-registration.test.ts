import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner as createOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { TeamOwnerError } from '../dist/team/contracts.js';

import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type { RegisterTeamRuntime } from '../dist/team/runtimeRegistrationContracts.js';
import type { TestContext } from 'node:test';

const code = (expected: string) => (error: unknown) =>
  error instanceof TeamOwnerError && error.code === expected;
function fixture(t: TestContext, edit?: (options: FilesystemTeamOwnerOptions) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-runtime-registration-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-registration' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding,
    store,
    savedSettings: { cwd: '/TEST/project', model: 'TEST-configured', skipPermissions: false },
    members: [
      { memberId: 'lead-id', name: 'captain', role: 'lead' },
      {
        memberId: 'worker-id',
        name: 'worker',
        role: 'member',
        settings: { workflow: 'TEST-preserve' },
      },
    ],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'admin', 'task.write', 'message.write'],
      },
      {
        principalId: 'bootstrap-agent',
        memberName: 'worker',
        permissions: ['read', 'task.write', 'message.write'],
      },
      { principalId: 'other-admin', memberName: 'user', permissions: ['read', 'admin'] },
    ],
    assertRosterEditable: () => {},
  };
  edit?.(options);
  const owner = createOwner(options),
    human = owner.connect('human');
  const request = (suffix = 'one'): RegisterTeamRuntime => ({
    commandId: `TEST-register-${suffix}`,
    expectedRevision: human.readRoster().revision,
    launchId: `TEST-launch-${suffix}`,
    members: human.readRoster().members.map((member) => ({
      memberId: member.memberId,
      principalId: `TEST-agent-${suffix}-${member.memberId}`,
      delivery: {
        ...binding,
        runId: `TEST-launch-${suffix}`,
        memberId: member.memberId,
        generation: '1',
      },
    })),
  });
  return {
    root,
    options,
    store,
    owner,
    human,
    request,
    state: () => store.read<OwnerState>('state.json')!,
    config: () => readFileSync(join(root, 'teams', binding.teamName, 'config.json'), 'utf8'),
  };
}

test('runtime registration atomically replaces only native bindings/grants, retaining product choices and original receipts', (t) => {
  const f = fixture(t);
  const initial = f.human.readRoster(),
    config = f.config();
  const first = f.request(),
    receipt = f.owner.registerRuntime('human', first);
  assert.deepEqual(receipt, {
    commandId: first.commandId,
    configurationRevision: initial.revision,
    launchId: first.launchId,
  });
  assert.deepEqual(f.human.readRoster(), initial);
  assert.equal(f.config(), config);
  assert.deepEqual(f.owner.runtimeCapture('human'), { ...receipt, members: first.members });
  assert.deepEqual(f.owner.runtimeCaptures('human'), [{ ...receipt, members: first.members }]);
  assert.equal('registerRuntime' in f.human, false);
  assert.equal(f.state().grants.find((grant) => grant.principalId === 'human')!.revoked, undefined);
  assert.equal(
    f.state().grants.find((grant) => grant.principalId === 'other-admin')!.revoked,
    undefined
  );
  assert.equal(
    f.state().grants.find((grant) => grant.principalId === 'bootstrap-agent')!.revoked,
    true
  );
  for (const member of first.members) {
    assert.deepEqual(
      f.state().members.find((row) => row.memberId === member.memberId)!.delivery,
      member.delivery
    );
    assert.deepEqual(
      f.state().grants.find((row) => row.principalId === member.principalId)!.permissions,
      ['read', 'task.write', 'message.write', 'process.write']
    );
    assert.ok(f.owner.connect(member.principalId).readRoster());
    const { teamName: _name, ...binding } = member.delivery;
    assert.equal(f.owner.hasRuntimeCapture('human', binding), true);
  }
  const second = f.request('two');
  f.owner.registerRuntime('human', second);
  assert.equal(f.owner.runtimeCapture('human')!.launchId, second.launchId);
  assert.equal(f.owner.runtimeCaptures('human').length, 2);
  assert.throws(
    () => f.owner.connect(first.members[0]!.principalId).readRoster(),
    code('forbidden')
  );
  assert.deepEqual(createOwner(f.options).registerRuntime('human', first), receipt);
  f.human.replaceRoster({
    commandId: 'TEST-product-edit',
    expectedRevision: initial.revision,
    members: [{ name: 'worker', model: 'TEST-new' }],
  });
  assert.equal(f.owner.runtimeCapture('human'), undefined);
  assert.equal(f.owner.runtimeCaptures('human').length, 2);
  assert.deepEqual(
    f.owner.registerRuntime('human', first),
    receipt,
    'replay precedes current product CAS'
  );
  f.human.revoke('human');
  assert.throws(() => f.owner.registerRuntime('human', first), code('forbidden'));
});

test('wrong membership, bindings, reused principals/runs and changed command payload cannot partially register', (t) => {
  const f = fixture(t);
  const original = f.request(),
    before = f.state(),
    config = f.config();
  const invalid: ((input: RegisterTeamRuntime) => void)[] = [
    (input) => {
      input.members.pop();
    },
    (input) => {
      input.members[1]!.memberId = 'unknown';
    },
    (input) => {
      input.members[1]!.memberId = input.members[0]!.memberId;
    },
    (input) => {
      input.members[1]!.delivery.backendId = 'FOREIGN';
    },
    (input) => {
      input.members[1]!.delivery.teamName = 'FOREIGN';
    },
    (input) => {
      input.members[1]!.delivery.memberId = 'FOREIGN';
    },
    (input) => {
      input.members[1]!.delivery.runId = 'FOREIGN';
    },
  ];
  for (const change of invalid) {
    const input = structuredClone(original);
    change(input);
    assert.throws(() => f.owner.registerRuntime('human', input), code('invalid'));
    assert.deepEqual(f.state(), before);
    assert.equal(f.config(), config);
  }
  for (const principalId of ['human', 'other-admin', 'bootstrap-agent']) {
    const input = structuredClone(original);
    input.members[0]!.principalId = principalId;
    assert.throws(() => f.owner.registerRuntime('human', input), code('conflict'));
    assert.deepEqual(f.state(), before);
  }
  const stale = { ...original, expectedRevision: '0'.repeat(64) };
  assert.throws(() => f.owner.registerRuntime('human', stale), code('conflict'));
  assert.throws(() => f.owner.registerRuntime('bootstrap-agent', original), code('forbidden'));
  const privateInput = {
    ...original,
    environment: { TOKEN: 'TEST-private' },
  } as RegisterTeamRuntime;
  assert.throws(() => f.owner.registerRuntime('human', privateInput), code('invalid'));
  f.owner.registerRuntime('human', original);
  const registered = f.state();
  assert.throws(
    () => f.owner.registerRuntime('human', { ...original, launchId: 'changed' }),
    code('conflict')
  );
  const reuse = f.request('two');
  reuse.members[0]!.principalId = original.members[0]!.principalId;
  assert.throws(() => f.owner.registerRuntime('human', reuse), code('conflict'));
  const sameRun = f.request('two');
  sameRun.launchId = original.launchId;
  assert.throws(() => f.owner.registerRuntime('human', sameRun), code('conflict'));
  assert.deepEqual(f.state(), registered);
});

for (const proof of ['live', 'unknown', 'async'] as const)
  test(`runtime registration refuses ${proof} custody proof without a partial publication`, (t) => {
    const f = fixture(t, (options) => {
      options.assertRosterEditable =
        proof === 'async'
          ? async () => {}
          : () => {
              throw new TeamOwnerError('hold');
            };
    });
    const before = f.state(),
      config = f.config();
    assert.throws(() => f.owner.registerRuntime('human', f.request()), code('hold'));
    assert.deepEqual(f.state(), before);
    assert.equal(f.config(), config);
  });

test('runtime registration rechecks current authority and configuration after the synchronous proof', (t) => {
  let revoke = () => {};
  const f = fixture(t, (options) => {
    options.assertRosterEditable = () => revoke();
  });
  revoke = () => f.human.revoke('human');
  assert.throws(() => f.owner.registerRuntime('human', f.request()), code('forbidden'));
  assert.equal(f.state().runtimeCaptures, undefined);
});

test('lost state acknowledgement reopens the exact capture without another proof or grant publication', (t) => {
  const f = fixture(t);
  const input = f.request(),
    write = f.store.write.bind(f.store);
  f.store.write = (name, value) => {
    write(name, value);
    if (name === 'state.json' && (value as OwnerState).runtimeCaptures?.length)
      throw new Error('TEST-ack-lost');
  };
  assert.throws(() => f.owner.registerRuntime('human', input), /TEST-ack-lost/);
  f.store.write = write;
  const before = f.state();
  const reopened = createOwner({
    ...f.options,
    assertRosterEditable: () => {
      throw new Error('must-not-repeat-proof');
    },
  });
  assert.deepEqual(reopened.registerRuntime('human', input), {
    commandId: input.commandId,
    configurationRevision: input.expectedRevision,
    launchId: input.launchId,
  });
  assert.deepEqual(f.state(), before);
});

test('runtime registration command IDs share the existing task/roster namespace', (t) => {
  const f = fixture(t);
  f.human.execute({
    commandId: 'TEST-task',
    operation: 'task.create',
    payload: { subject: 'TEST preserve' },
  });
  assert.throws(
    () => f.owner.registerRuntime('human', { ...f.request(), commandId: 'TEST-task' }),
    code('conflict')
  );
  f.human.replaceRoster({
    commandId: 'TEST-roster',
    expectedRevision: f.human.readRoster().revision,
    members: [{ name: 'worker', workflow: 'TEST-preserve' }],
  });
  assert.throws(
    () => f.owner.registerRuntime('human', { ...f.request(), commandId: 'TEST-roster' }),
    code('conflict')
  );
  const input = f.request();
  f.owner.registerRuntime('human', input);
  assert.throws(
    () =>
      f.human.execute({
        commandId: input.commandId,
        operation: 'task.create',
        payload: { subject: 'TEST forbidden collision' },
      }),
    code('conflict')
  );
});

test('a product edit during release proof rejects the older registration CAS', (t) => {
  let edit = () => {};
  const f = fixture(t, (options) => {
    options.assertRosterEditable = () => edit();
  });
  const input = f.request();
  edit = () => {
    edit = () => {};
    f.human.replaceRoster({
      commandId: 'TEST-proof-product-edit',
      expectedRevision: input.expectedRevision,
      members: [{ name: 'worker', model: 'TEST-newer-config' }],
    });
  };
  assert.throws(() => f.owner.registerRuntime('human', input), code('conflict'));
  assert.equal(f.state().runtimeCaptures, undefined);
  assert.equal(f.state().members[1]!.settings!.model, 'TEST-newer-config');
});

test('detached runtime history still requires an explicit release proof for new registration', (t) => {
  const f = fixture(t);
  f.owner.registerRuntime('human', f.request());
  f.human.replaceRoster({
    commandId: 'TEST-detach',
    expectedRevision: f.human.readRoster().revision,
    members: [{ name: 'worker', model: 'TEST-changed' }],
  });
  const input = f.request('two'),
    before = f.state();
  const { assertRosterEditable: _proof, ...withoutProof } = f.options;
  const unproven = createOwner(withoutProof);
  assert.ok(before.members.every((member) => !member.delivery));
  assert.throws(() => unproven.registerRuntime('human', input), code('hold'));
  assert.deepEqual(f.state(), before);
});

test('registration revokes an old bootstrap agent admin bound to native delivery, preserving operator and unbound admin grants', (t) => {
  const f = fixture(t, (options) => {
    options.members[0]!.delivery = {
      ...options.binding,
      runId: 'TEST-bootstrap-run',
      memberId: 'lead-id',
      generation: '1',
    };
    options.grants.push(
      {
        principalId: 'bootstrap-lead-admin',
        memberName: 'captain',
        permissions: ['read', 'admin', 'task.write', 'message.write'],
      },
      { principalId: 'unbound-admin', memberName: 'worker', permissions: ['read', 'admin'] }
    );
    // The actual trusted operator may also have a member-labelled admin grant.
    options.grants[0]!.memberName = 'captain';
  });
  f.owner.registerRuntime('human', f.request());
  assert.equal(
    f.state().grants.find((grant) => grant.principalId === 'bootstrap-lead-admin')!.revoked,
    true
  );
  assert.throws(() => f.owner.connect('bootstrap-lead-admin').readRoster(), code('forbidden'));
  assert.ok(f.owner.connect('human').readRoster());
  assert.ok(f.owner.connect('other-admin').readRoster());
  assert.ok(f.owner.connect('unbound-admin').readRoster());
});

test('corrupt runtime capture history blocks ordinary Team reads and mutations', (t) => {
  const f = fixture(t);
  f.owner.registerRuntime('human', f.request());
  const state = f.state();
  state.runtimeCaptures![0]!.fingerprint = '0'.repeat(64);
  f.store.write('state.json', state);
  assert.throws(() => f.human.readRoster(), code('hold'));
  assert.throws(
    () =>
      f.human.execute({
        commandId: 'TEST-corrupt-write',
        operation: 'task.create',
        payload: { subject: 'TEST-no-write' },
      }),
    code('hold')
  );
  assert.deepEqual(f.state(), state);
});

test('launch workspace preflight reuses registration guards and publishes neither grants nor receipts', (t) => {
  let released = true;
  const f = fixture(t, (options) => {
    options.assertRosterEditable = () => {
      if (!released) throw new TeamOwnerError('hold');
    };
  });
  const input = f.request(),
    before = f.state(),
    config = f.config();
  const proof = f.owner.assertRuntimeRegistration('human', input);
  assert.match(proof, /^[a-f0-9]{64}$/);
  assert.equal(f.owner.assertRuntimeRegistration('human', input), proof);
  assert.notEqual(
    f.owner.assertRuntimeRegistration('other-admin', input),
    proof,
    'the original operator is part of admission'
  );
  assert.deepEqual(f.state(), before);
  assert.equal(f.config(), config);
  assert.equal('assertRuntimeRegistration' in f.human, false);
  released = false;
  assert.throws(() => f.owner.assertRuntimeRegistration('human', input), code('hold'));
  assert.deepEqual(f.state(), before);
  released = true;
  f.human.revoke('human');
  assert.throws(() => f.owner.assertRuntimeRegistration('human', input), code('forbidden'));
  assert.equal(f.state().runtimeCaptures, undefined);
});
