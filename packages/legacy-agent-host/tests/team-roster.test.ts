import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFilesystemTeamOwner as createOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { TeamOwnerError } from '../dist/team/contracts.js';
import { digest } from '../dist/team/identity.js';
import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { OwnerState } from '../dist/team/ownerState.js';
import type {
  ReplaceTeamRoster,
  TeamMemberSettings,
  TeamRosterConfiguration,
  TeamMemberSettingsRelaunchIntent,
} from '../dist/team/rosterContracts.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext, edit?: (options: FilesystemTeamOwnerOptions) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-roster-owner-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team', teamName: 'test-roster' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding,
    store,
    members: [
      { memberId: 'lead-id', name: 'captain', role: 'lead' },
      { memberId: 'alice-id', name: 'alice', role: 'member' },
      { memberId: 'bob-id', name: 'bob', role: 'member' },
    ],
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'admin', 'task.write', 'message.write'],
      },
      {
        principalId: 'alice-session',
        memberName: 'alice',
        permissions: ['read', 'task.write', 'message.write'],
      },
    ],
  };
  edit?.(options);
  const owner = createOwner(options),
    human = owner.connect('human');
  const request = (
    commandId: string,
    members: ReplaceTeamRoster['members'] = [{ name: 'alice' }, { name: 'bob' }]
  ): ReplaceTeamRoster => ({ commandId, expectedRevision: human.readRoster().revision, members });
  return {
    root,
    options,
    owner,
    human,
    store,
    request,
    config: () => readFileSync(join(root, 'teams', binding.teamName, 'config.json'), 'utf8'),
    state: () => store.read<OwnerState>('state.json')!,
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof TeamOwnerError && error.code === expected;

function settingsIntent(
  roster: TeamRosterConfiguration,
  memberName: string,
  model: string | null,
  effort: TeamMemberSettingsRelaunchIntent['effort']
): TeamMemberSettingsRelaunchIntent {
  const target = roster.members.find((member) => member.name === memberName)!;
  return {
    memberName,
    targetKind: target.role,
    expectedFingerprint: target.settingsFingerprint!,
    expectedTeamSettingsFingerprint: roster.revision,
    baseline: roster.members.map((member) => ({
      memberName: member.name,
      expectedFingerprint: member.settingsFingerprint!,
    })),
    model,
    effort,
  };
}

for (const targetKind of ['lead', 'member'] as const) {
  test(`member-settings ${targetKind} intent saves, clears, and replays the original decision`, (t) => {
    const f = fixture(t, (options) => {
      options.savedSettings = { cwd: '/TEST/project' };
    });
    const targetName = targetKind === 'lead' ? 'captain' : 'alice';
    let original: ReplaceTeamRoster | undefined;
    let originalReceipt: { commandId: string; revision: string } | undefined;
    for (const clear of [false, true]) {
      const roster = f.human.readRoster();
      for (const member of roster.members)
        assert.equal(
          member.settingsFingerprint,
          digest({
            binding: f.options.binding,
            revision: roster.revision,
            memberId: member.memberId,
          })
        );
      const model = clear ? null : 'TEST-selected';
      const effort = clear ? null : 'ultra';
      const input = {
        ...f.request(`TEST-editor-${clear}`),
        memberSettingsRelaunch: settingsIntent(roster, targetName, model, effort),
      };
      const choices = clear ? {} : { model: model!, effort: 'ultra' as const };
      if (targetKind === 'lead') input.savedSettings = { cwd: '/TEST/project', ...choices };
      else input.members[0] = { name: 'alice', ...choices };
      const receipt = f.human.replaceRoster(input);
      if (!original) {
        original = input;
        originalReceipt = receipt;
      }
      const saved = f.human.readRoster();
      const settings = targetKind === 'lead' ? saved.savedSettings! : saved.members[1]!.settings;
      assert.equal(settings.model ?? null, model);
      assert.equal(settings.effort ?? null, effort);
      assert.notEqual(
        saved.members[1]!.settingsFingerprint,
        roster.members[1]!.settingsFingerprint
      );
      assert.deepEqual(createOwner(f.options).connect('human').replaceRoster(input), receipt);
    }
    assert.deepEqual(
      f.human.replaceRoster(original!),
      originalReceipt,
      'replay precedes comparison with newer target/baseline tokens'
    );
    const before = f.config();
    f.human.revoke('human');
    assert.throws(() => f.human.replaceRoster(original!), code('forbidden'));
    assert.equal(f.config(), before);
  });
}

test('member-settings stale targets, baselines and contradictory intent cannot publish', (t) => {
  const f = fixture(t);
  const initial = f.human.readRoster();
  const base: ReplaceTeamRoster = {
    ...f.request('TEST-editor-invalid'),
    memberSettingsRelaunch: settingsIntent(initial, 'alice', null, null),
  };
  const beforeConfig = f.config(),
    beforeState = f.state();
  const changes: ((input: ReplaceTeamRoster) => void)[] = [
    (input) => {
      input.memberSettingsRelaunch!.expectedFingerprint = '0'.repeat(64);
    },
    (input) => {
      input.memberSettingsRelaunch!.expectedTeamSettingsFingerprint = '0'.repeat(64);
    },
    (input) => {
      input.memberSettingsRelaunch!.baseline[0]!.expectedFingerprint = '0'.repeat(64);
    },
    (input) => {
      input.memberSettingsRelaunch!.baseline.pop();
    },
    (input) => {
      input.memberSettingsRelaunch!.baseline[1] = input.memberSettingsRelaunch!.baseline[0]!;
    },
    (input) => {
      input.memberSettingsRelaunch!.baseline[0]!.memberName = 'unknown';
    },
    (input) => {
      input.memberSettingsRelaunch!.targetKind = 'lead';
    },
    (input) => {
      input.memberSettingsRelaunch!.memberName = 'unknown';
    },
    (input) => {
      input.memberSettingsRelaunch!.model = 'TEST-mismatch';
    },
    (input) => {
      input.memberSettingsRelaunch!.effort = 'low';
    },
    (input) => {
      input.members.pop();
    },
    (input) => {
      input.members[1]!.name = 'renamed';
    },
    (input) => {
      input.members.push({ name: 'extra' });
    },
    (input) => {
      input.memberSettingsRelaunch = settingsIntent(initial, 'captain', null, null);
    },
  ];
  for (const change of changes) {
    const input = structuredClone(base);
    change(input);
    assert.throws(() => f.human.replaceRoster(input), code('conflict'));
    assert.equal(f.config(), beforeConfig);
    assert.deepEqual(f.state(), beforeState);
  }
  for (const bad of [
    { nativeSessionId: 'TEST-private' },
    { expectedFingerprint: 'A'.repeat(64) },
    { effort: 'unsupported' },
    { model: 'x'.repeat(257) },
    {
      baseline: [
        {
          memberName: 'alice',
          expectedFingerprint: initial.members[1]!.settingsFingerprint,
          environment: {},
        },
      ],
    },
  ]) {
    const input = {
      ...base,
      memberSettingsRelaunch: { ...base.memberSettingsRelaunch, ...bad },
    } as ReplaceTeamRoster;
    assert.throws(() => f.human.replaceRoster(input), code('invalid'));
    assert.deepEqual(f.state(), beforeState);
  }
});

test('configured Team choices survive cold reopen, teammate-only saves and explicit default/clear replacements', (t) => {
  const f = fixture(t, (options) => {
    options.savedSettings = {
      cwd: '/TEST/project',
      displayName: 'TEST display',
      description: 'TEST description',
      color: '#123456',
      prompt: '  TEST prompt\n',
      providerId: 'anthropic',
      providerBackendId: 'cli-sdk',
      model: 'TEST-chosen',
      effort: 'high',
      fastMode: 'off',
      syncModelsWithLead: false,
      limitContext: false,
      skipPermissions: false,
      worktree: 'TEST-worktree',
      extraCliArgs: ' --TEST="quoted text" ',
      allowExperimentalLocalModels: false,
    };
  });
  const initial = f.human.readRoster();
  assert.deepEqual(initial.savedSettings, f.options.savedSettings);
  assert.equal(f.owner.matchesCapturedRoster(f.options.members, f.options.savedSettings), true);
  const reopened = createOwner({
    ...f.options,
    savedSettings: { cwd: '/TEST/wrong-reopen' },
  }).connect('human');
  assert.deepEqual(
    reopened.readRoster(),
    initial,
    'descriptor bootstrap never overwrites owner choices'
  );
  f.human.replaceRoster(f.request('TEST-members-only'));
  assert.deepEqual(f.human.readRoster().savedSettings, initial.savedSettings);
  const explicit = { ...f.request('TEST-defaults'), savedSettings: { cwd: '/TEST/project' } };
  const receipt = f.human.replaceRoster(explicit);
  assert.notEqual(receipt.revision, initial.revision);
  assert.deepEqual(f.human.readRoster().savedSettings, { cwd: '/TEST/project' });
  assert.deepEqual(JSON.parse(f.config()).savedSettings, { cwd: '/TEST/project' });
  assert.ok(
    !f.config().includes('TEST-chosen'),
    'clearing does not retain old projected overrides'
  );
  assert.deepEqual(createOwner(f.options).connect('human').replaceRoster(explicit), receipt);
  assert.throws(
    () => f.human.replaceRoster({ ...explicit, savedSettings: undefined }),
    code('conflict')
  );
  assert.equal(f.owner.matchesCapturedRoster(f.options.members, f.options.savedSettings), false);
});

test('settings-only edits require current released Runtime proof and invalidate all old capture authority', (t) => {
  const f = fixture(t, (options) => {
    options.members[1]!.delivery = {
      ...options.binding,
      runId: 'TEST-run',
      memberId: 'alice-id',
      generation: '1',
    };
  });
  const input = {
    ...f.request('TEST-settings-only'),
    savedSettings: { cwd: '/TEST/new', skipPermissions: false },
  };
  const before = f.config();
  assert.equal(
    f.human.readRoster().savedSettings,
    undefined,
    'unknown capture is not default settings'
  );
  assert.throws(() => f.human.replaceRoster(input), code('hold'));
  assert.equal(f.config(), before);
  const released = createOwner({ ...f.options, assertRosterEditable: () => {} }).connect('human');
  const receipt = released.replaceRoster(input);
  assert.notEqual(receipt.revision, input.expectedRevision);
  assert.ok(f.state().members.every((member) => !member.delivery));
  assert.throws(() => f.owner.connect('alice-session').readRoster(), code('forbidden'));
  const snapshot = released.readSnapshot() as { configurationRevision: string };
  assert.equal(snapshot.configurationRevision, receipt.revision);
  assert.throws(
    () => released.replaceRoster({ ...input, commandId: 'TEST-old-form' }),
    code('conflict')
  );
});

test('saved settings round-trip every existing member option and full replacement clears omitted overrides', (t) => {
  const f = fixture(t);
  const settings: TeamMemberSettings = {
    role: 'Reviewer',
    workflow: 'Use existing project rules',
    isolation: 'worktree',
    cwd: f.root,
    providerId: 'codex',
    providerBackendId: 'codex-native',
    model: 'TEST-model',
    effort: 'ultra',
    fastMode: 'off',
    mcpPolicy: {
      mode: 'inheritScopes',
      scopes: { user: false, project: true, local: false },
      serverNames: ['TEST-server'],
    },
  };
  const original = f.human.readRoster();
  const receipt = f.human.replaceRoster(
    f.request('TEST-settings', [{ name: 'alice', ...settings }, { name: 'bob' }])
  );
  const saved = f.human.readRoster();
  assert.notEqual(saved.revision, original.revision);
  assert.equal(saved.revision, receipt.revision);
  assert.deepEqual(saved.members[1], {
    memberId: 'alice-id',
    name: 'alice',
    role: 'member',
    settingsFingerprint: saved.members[1]!.settingsFingerprint,
    settings,
  });
  assert.deepEqual(createOwner(f.options).connect('human').readRoster(), saved);
  f.human.replaceRoster(f.request('TEST-clear'));
  assert.deepEqual(f.human.readRoster().members[1]!.settings, {});
  assert.ok(!f.config().includes('TEST-model'));
  assert.notEqual(
    f.human.readRoster().revision,
    original.revision,
    'returning to prior values cannot revive an old revision'
  );
});

test('add/remove/restore retain product IDs and Task bytes; an old member grant never revives', (t) => {
  const f = fixture(t);
  const task = f.human.execute({
    commandId: 'TEST-task',
    operation: 'task.create',
    payload: { subject: 'Keep original history', owner: 'alice' },
  });
  const taskPath = join(f.root, 'tasks', 'test-roster', task.effects.taskId + '.json');
  const before = readFileSync(taskPath);
  f.human.replaceRoster(
    f.request('TEST-remove', [{ name: 'new-worker', workflow: 'TEST instructions' }])
  );
  const removed = f.human.readRoster();
  assert.deepEqual(
    removed.members.map((member) => member.name),
    ['captain', 'new-worker']
  );
  assert.equal(
    removed.removedMembers.find((member) => member.name === 'alice')!.memberId,
    'alice-id'
  );
  assert.deepEqual(readFileSync(taskPath), before);
  assert.throws(() => f.owner.connect('alice-session').readRoster(), code('forbidden'));
  f.human.replaceRoster(f.request('TEST-restore', [{ name: 'alice' }, { name: 'new-worker' }]));
  const restored = f.human.readRoster();
  assert.equal(restored.members.find((member) => member.name === 'alice')!.memberId, 'alice-id');
  assert.ok(!restored.removedMembers.some((member) => member.memberId === 'alice-id'));
  assert.throws(
    () =>
      f.owner.connect('alice-session').execute({
        commandId: 'TEST-old-agent',
        operation: 'task.create',
        payload: { subject: 'Must refuse' },
      }),
    code('forbidden')
  );
  assert.deepEqual(readFileSync(taskPath), before);
  assert.ok(!f.state().members.find((member) => member.name === 'alice')!.delivery);
});

test('unchanged roster records one original intent without detaching targets or invoking Runtime proof', (t) => {
  let proofs = 0;
  const f = fixture(t, (options) => {
    options.assertRosterEditable = () => {
      proofs++;
    };
    options.members[1]!.delivery = {
      ...options.binding,
      runId: 'TEST-run',
      memberId: 'alice-id',
      generation: '1',
    };
  });
  const input = f.request('TEST-noop');
  input.memberSettingsRelaunch = settingsIntent(f.human.readRoster(), 'alice', null, null);
  const first = f.human.replaceRoster(input);
  assert.equal(first.revision, input.expectedRevision);
  assert.deepEqual(f.human.replaceRoster(input), first);
  assert.equal(f.state().rosterCommands!.length, 1);
  assert.equal(proofs, 0);
  assert.equal(f.state().members[1]!.delivery!.generation, '1');
  assert.equal(f.owner.matchesCapturedRoster(f.options.members), true);
  const opaque = f.request(' TEST-opaque ');
  assert.equal(f.human.replaceRoster(opaque).commandId, opaque.commandId);
  assert.equal(
    f.human.lookupRoster('TEST-opaque'),
    undefined,
    'command identity is never trimmed into another intent'
  );
});

test('no Runtime proof cannot edit a bound member; confirmed release detaches all old targets/grants', (t) => {
  const f = fixture(t, (options) => {
    options.members[1]!.delivery = {
      ...options.binding,
      runId: 'TEST-run',
      memberId: 'alice-id',
      generation: '1',
    };
  });
  const input = f.request('TEST-bound-edit', [{ name: 'alice', model: 'TEST-new' }]);
  const before = f.config();
  assert.throws(() => f.human.replaceRoster(input), code('hold'));
  assert.equal(f.config(), before);
  assert.equal(f.human.lookupRoster(input.commandId), undefined);
  const asynchronous = createOwner({ ...f.options, assertRosterEditable: async () => {} }).connect(
    'human'
  );
  assert.throws(
    () => asynchronous.replaceRoster(input),
    code('hold'),
    'an asynchronous proof is never treated as synchronous custody evidence'
  );
  const released = createOwner({ ...f.options, assertRosterEditable: () => {} }).connect('human');
  released.replaceRoster(input);
  assert.ok(f.state().members.every((member) => !member.delivery));
  assert.throws(() => f.owner.connect('alice-session').readRoster(), code('forbidden'));
  assert.equal(f.owner.matchesCapturedRoster(f.options.members), false);
});

test('stale revisions, changed payload IDs, unauthorized replay and cross-operation reuse fail before product writes', (t) => {
  const f = fixture(t);
  const old = f.request('TEST-original', [{ name: 'alice', model: 'TEST-original' }]);
  const receipt = f.human.replaceRoster(old);
  const before = f.config();
  assert.throws(() => f.human.replaceRoster({ ...old, commandId: 'TEST-stale' }), code('conflict'));
  assert.throws(
    () => f.human.replaceRoster({ ...old, members: [{ name: 'bob' }] }),
    code('conflict')
  );
  assert.deepEqual(f.human.lookupRoster(old.commandId), receipt);
  assert.throws(() => f.owner.connect('alice-session').replaceRoster(old), code('forbidden'));
  assert.throws(
    () => f.owner.connect('alice-session').lookupRoster(old.commandId),
    code('forbidden')
  );
  assert.throws(
    () =>
      f.human.execute({
        commandId: old.commandId,
        operation: 'task.create',
        payload: { subject: 'Wrong operation' },
      }),
    code('conflict')
  );
  f.human.execute({
    commandId: 'TEST-task-id',
    operation: 'task.create',
    payload: { subject: 'Original Task' },
  });
  assert.throws(() => f.human.replaceRoster(f.request('TEST-task-id')), code('conflict'));
  assert.equal(f.config(), before);
});

test('invalid/hostile full requests never partially publish, and descriptive role cannot replace the lead', (t) => {
  const f = fixture(t);
  const before = f.config();
  const choices: unknown[] = [
    [{ name: 'alice' }, { name: 'Alice' }],
    [{ name: 'captain' }],
    [{ name: 'user' }],
    [{ name: 'team-lead' }],
    [{ name: 'worker-10' }],
    [{ name: 'alice', memberId: 'lead-id' }],
    [{ name: 'alice', environment: { TOKEN: 'TEST-no-secret' } }],
    [{ name: 'alice', mcpPolicy: { mode: 'appOnly', scopes: { user: 'false' } } }],
    [{ name: 'alice', fastMode: false }],
    [{ name: 'alice', effort: 'unsupported' }],
  ];
  for (const members of choices)
    assert.throws(
      () => f.human.replaceRoster({ ...f.request('TEST-invalid'), members } as ReplaceTeamRoster),
      code('invalid')
    );
  for (const savedSettings of [
    null,
    {},
    { cwd: ' ' },
    { cwd: '/TEST/project', environment: { TOKEN: 'TEST' } },
    { cwd: '/TEST/project', skipPermissions: 'false' },
    { cwd: '/TEST/project', extraCliArgs: '\0TEST' },
  ])
    assert.throws(
      () =>
        f.human.replaceRoster({
          ...f.request('TEST-invalid-global'),
          savedSettings,
        } as ReplaceTeamRoster),
      code('invalid')
    );
  assert.equal(f.config(), before);
  assert.equal(f.state().rosterCommands, undefined);
  f.human.replaceRoster(f.request('TEST-role', [{ name: 'alice', role: 'team-lead' }]));
  assert.equal(f.human.readRoster().members[0]!.role, 'lead');
  assert.equal(f.human.readRoster().members[1]!.role, 'member');
  const config = JSON.parse(f.config()) as { members: { name: string; role: string }[] };
  assert.equal(config.members.find((member) => member.name === 'alice')!.role, 'member');
  assert.equal(f.human.readRoster().members[1]!.settings.role, 'team-lead');
});

for (const point of ['state-admission', 'config-projection', 'state-completion'] as const) {
  test(`lost ${point} acknowledgement recovers the exact decided roster and original receipt`, (t) => {
    const f = fixture(t);
    const input = f.request('TEST-ambiguous', [
      { name: 'alice', workflow: 'TEST preserved' },
      { name: 'bob' },
    ]);
    input.memberSettingsRelaunch = settingsIntent(f.human.readRoster(), 'alice', null, null);
    input.savedSettings = {
      cwd: '/TEST/project',
      prompt: 'TEST recover exact global settings',
      skipPermissions: false,
    };
    const write = f.store.write.bind(f.store);
    let failed = false;
    f.store.write = (name, value) => {
      write(name, value);
      const state = value as OwnerState;
      if (
        !failed &&
        (point === 'state-admission'
          ? name === 'state.json' && !!state.rosterProjection
          : point === 'config-projection'
            ? name === '../config.json'
            : name === 'state.json' && !!state.rosterCommands?.length && !state.rosterProjection)
      ) {
        failed = true;
        throw new Error('TEST-write-observation-lost');
      }
    };
    assert.throws(() => f.human.replaceRoster(input), /TEST-write-observation-lost/);
    f.store.write = write;
    const recovered = createOwner(f.options).connect('human');
    const saved = recovered.readRoster();
    const bytes = f.config();
    assert.equal(saved.members[2]!.name, 'bob');
    assert.equal(saved.members[1]!.settings.workflow, 'TEST preserved');
    assert.deepEqual(saved.savedSettings, input.savedSettings);
    assert.deepEqual(recovered.replaceRoster(input), {
      commandId: input.commandId,
      revision: saved.revision,
    });
    assert.equal(f.config(), bytes);
    assert.equal(f.state().rosterCommands!.length, 1);
    assert.equal(f.state().rosterProjection, undefined);
  });
}

test('projection recovery refuses a foreign config instead of overwriting it', (t) => {
  const f = fixture(t);
  const write = f.store.write.bind(f.store);
  f.store.write = (name, value) => {
    write(name, value);
    if (name === 'state.json' && (value as OwnerState).rosterProjection)
      throw new Error('TEST-admitted');
  };
  assert.throws(
    () => f.human.replaceRoster(f.request('TEST-foreign', [{ name: 'alice' }])),
    /TEST-admitted/
  );
  f.store.write = write;
  const foreign = JSON.stringify({ name: 'test-roster', members: [], TEST: 'foreign-writer' });
  writeFileSync(join(f.root, 'teams', 'test-roster', 'config.json'), foreign);
  assert.throws(() => createOwner(f.options).connect('human').readRoster(), code('hold'));
  assert.equal(f.config(), foreign);
});

test('pending canonical Task or delivery obligations hold a new roster decision', (t) => {
  const f = fixture(t);
  const input = f.request('TEST-held', [{ name: 'alice' }]);
  f.store.write('commands/TEST-pending.json', { phase: 'held' });
  assert.throws(() => f.human.replaceRoster(input), code('hold'));
  rmSync(join(f.store.directory, 'commands', 'TEST-pending.json'));
  f.store.write('outbox/TEST-pending.json', { phase: 'pending' });
  assert.throws(() => f.human.replaceRoster(input), code('hold'));
  assert.equal(f.human.lookupRoster(input.commandId), undefined);
});

test('authority is rechecked after Runtime proof and an actor cannot publish after revoke', (t) => {
  const f = fixture(t, (options) => {
    options.assertRosterEditable = () => f.human.revoke('human');
  });
  const input = f.request('TEST-revoked', [{ name: 'alice' }]);
  assert.throws(() => f.human.replaceRoster(input), code('forbidden'));
  assert.equal(f.state().rosterCommands, undefined);
});

test('storage budgets and corrupt recorded settings hold without a replacement intent', (t) => {
  const f = fixture(t);
  const state = f.state();
  state.rosterVersion = Number.MAX_SAFE_INTEGER;
  f.store.write('state.json', state);
  assert.throws(() => f.human.readRoster(), code('hold'));
  state.rosterVersion = 0;
  state.savedSettings = {
    cwd: '/TEST/project',
    nativeSessionId: 'TEST-private',
  } as NonNullable<typeof state.savedSettings>;
  f.store.write('state.json', state);
  assert.throws(() => f.human.readRoster(), code('hold'));
  delete state.savedSettings;
  state.members[1]!.settings = { environment: 'TEST-denied' } as TeamMemberSettings;
  f.store.write('state.json', state);
  assert.throws(() => f.human.readRoster(), code('hold'));
  assert.equal(f.store.read(`commands/${digest('TEST-not-admitted')}.json`), undefined);
});

test('verified roster lookup proves the original payload after later edits without replaying effects', (t) => {
  const f = fixture(t);
  const original = f.request('TEST-verified', [
    { name: 'alice', model: 'TEST-configured' },
    { name: 'bob' },
  ]);
  original.memberSettingsRelaunch = settingsIntent(
    f.human.readRoster(),
    'alice',
    'TEST-configured',
    null
  );
  const receipt = f.human.replaceRoster(original);
  const { commandId, ...expected } = original;
  f.human.replaceRoster(f.request('TEST-newer'));
  const before = f.state(),
    config = f.config();
  assert.deepEqual(f.human.lookupRoster(commandId, expected), receipt);
  assert.equal(f.human.lookupRoster('TEST-absent', expected), undefined);
  assert.throws(
    () => f.human.lookupRoster(commandId, { ...expected, members: [] }),
    code('conflict')
  );
  assert.throws(
    () => f.owner.connect('alice-session').lookupRoster(commandId, expected),
    code('forbidden')
  );
  assert.throws(
    () =>
      f.human.lookupRoster(commandId, {
        ...expected,
        nativeSessionId: 'TEST-private',
      } as typeof expected),
    code('invalid')
  );
  assert.deepEqual(f.state(), before);
  assert.equal(f.config(), config);
});
