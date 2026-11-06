import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import { TeamOwnerError } from '../dist/team/contracts.js';

import type { FilesystemTeamOwnerOptions } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-namespace-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-team' };
  const options: FilesystemTeamOwnerOptions = {
    root,
    binding,
    members: [{ memberId: 'lead-id', name: 'lead', role: 'lead' }],
    grants: [
      { principalId: 'human', memberName: 'user', permissions: ['read', 'task.write', 'admin'] },
    ],
  };
  const team = join(root, 'teams', binding.teamName);
  const state = join(team, '.host-owner', 'state.json');
  return { root, team, state, options };
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** Includes unexpected directories/locks/owner metadata, not only product JSON. */
function census(root: string): unknown[] {
  const rows: unknown[] = [];
  const visit = (relative: string) => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    rows.push({
      relative,
      mode: stat.mode,
      inode: stat.ino,
      modified: stat.mtimeMs,
      ...(stat.isFile() ? { bytes: readFileSync(path).toString('base64') } : {}),
      ...(stat.isSymbolicLink() ? { link: readlinkSync(path) } : {}),
    });
    if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) visit(relative ? `${relative}/${name}` : name);
  };
  visit('');
  return rows;
}

function refusesWithoutWrites(f: ReturnType<typeof fixture>): void {
  const before = census(f.root);
  assert.throws(
    () => createFilesystemTeamOwner(f.options),
    (error: unknown) => error instanceof TeamOwnerError && ['conflict', 'hold'].includes(error.code)
  );
  assert.deepEqual(census(f.root), before, 'refusal must precede mkdir, locks, state and config');
}

test('intact legacy config is refused before adding .host-owner metadata', (t) => {
  const f = fixture(t);
  write(join(f.team, 'config.json'), { name: 'test-team', members: [{ name: 'lead' }] });
  refusesWithoutWrites(f);
  assert.equal(readdirSync(f.team).includes('.host-owner'), false);
});

test('orphan legacy Task data without config or Host state cannot be adopted', (t) => {
  const f = fixture(t);
  write(join(f.root, 'tasks', 'test-team', 'legacy-task.json'), {
    id: 'legacy-task',
    subject: 'Existing user Task',
    description: 'Keep these bytes',
    status: 'pending',
    owner: 'lead',
    blocks: [],
    blockedBy: [],
    comments: [],
  });
  refusesWithoutWrites(f);
  assert.equal(readdirSync(f.root).includes('teams'), false);
});

test('TeamHost orphan Task refusal releases its transient profile lease without persistent additions', (t) => {
  const f = fixture(t);
  write(join(f.root, 'tasks', 'test-team', 'legacy-task.json'), {
    id: 'legacy-task',
    subject: 'Existing user Task',
    status: 'pending',
  });
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => {
    input.destroy();
    output.destroy();
  });
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    owner: {
      ownerId: f.options.binding.backendId,
      revision: 'TEST-revision',
      storageRoot: f.root,
      profileId: 'TEST-profile',
      protocolVersion: 1,
      buildId: 'TEST-host',
      nodeSha256: '0'.repeat(64),
      hostEntrySha256: '0'.repeat(64),
    },
    principalId: 'human',
    teams: [
      {
        scope: {
          projectId: 'TEST-project',
          workspaceId: 'TEST-workspace',
          teamId: f.options.binding.teamId,
          runId: 'TEST-run',
          memberId: 'human',
          generation: '1',
        },
        binding: f.options.binding,
        members: [{ memberId: 'lead-id', name: 'lead', role: 'lead' }],
        grants: [
          {
            principalId: 'human',
            memberName: 'user',
            permissions: ['read', 'task.write', 'admin'],
          },
        ],
      },
    ],
  };
  const entriesBefore = readdirSync(f.root).sort();
  const tasksBefore = census(join(f.root, 'tasks'));
  assert.throws(() => createTeamHost(profile, { input, output }), TeamOwnerError);
  // The lease can update the root directory mtime while publishing/removing its
  // own lock. It must leave no lock, candidate, Team or Host metadata behind.
  assert.deepEqual(readdirSync(f.root).sort(), entriesBefore);
  assert.deepEqual(census(join(f.root, 'tasks')), tasksBefore);
  assert.equal(output.readableLength, 0, 'a refused Host never advertises readiness');
});

test('orphan inbox data without config or Host state cannot acquire new grants', (t) => {
  const f = fixture(t);
  write(join(f.team, 'inboxes', 'lead.json'), [
    { from: 'user', text: 'Private legacy message', messageId: 'old-message', read: false },
  ]);
  refusesWithoutWrites(f);
  assert.equal(readdirSync(f.team).includes('.host-owner'), false);
});

test('unproven private owner records cannot stand in for matching ownership state', (t) => {
  const f = fixture(t);
  write(join(f.team, '.host-owner', 'commands', 'old-command.json'), { phase: 'held' });
  refusesWithoutWrites(f);
});

test('malformed or foreign Host ownership state is refused without changing bytes', (t) => {
  for (const state of [
    {
      schemaVersion: 2,
      binding: { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-team' },
      members: [],
      grants: [],
      ready: true,
    },
    {
      schemaVersion: 1,
      binding: { backendId: 'foreign-owner', teamId: 'TEST-team', teamName: 'test-team' },
      members: [],
      grants: [],
      ready: true,
    },
    {
      schemaVersion: 1,
      binding: { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-team' },
      ready: true,
    },
  ]) {
    const f = fixture(t);
    write(f.state, state);
    refusesWithoutWrites(f);
  }
});

test('a clean target namespace supports first bootstrap and matching Host reopen', (t) => {
  const f = fixture(t);
  const owner = createFilesystemTeamOwner(f.options);
  const command = {
    commandId: 'fresh-create',
    operation: 'task.create' as const,
    payload: { subject: 'Host-owned task', owner: 'lead' },
  };
  const receipt = owner.connect('human').execute(command);
  assert.equal(receipt.phase, 'completed');
  const stateBefore = readFileSync(f.state, 'utf8');
  const configBefore = readFileSync(join(f.team, 'config.json'), 'utf8');
  const reopened = createFilesystemTeamOwner(f.options).connect('human');
  assert.equal(reopened.getTask(receipt.effects.taskId).subject, 'Host-owned task');
  assert.deepEqual(reopened.execute(command), receipt);
  assert.equal(readFileSync(f.state, 'utf8'), stateBefore);
  assert.equal(readFileSync(join(f.team, 'config.json'), 'utf8'), configBefore);
});

test('matching ready:false state can finish an interrupted bootstrap', (t) => {
  const f = fixture(t);
  createFilesystemTeamOwner(f.options);
  const state = JSON.parse(readFileSync(f.state, 'utf8')) as { ready: boolean };
  state.ready = false;
  write(f.state, state);
  unlinkSync(join(f.team, 'config.json'));
  const reopened = createFilesystemTeamOwner(f.options).connect('human');
  assert.deepEqual(reopened.listTasks(), []);
  assert.equal((JSON.parse(readFileSync(f.state, 'utf8')) as { ready: boolean }).ready, true);
});

test('an empty preconstructed TEST store is accepted but does not bypass product-data admission', (t) => {
  const fresh = fixture(t);
  const store = new TeamOwnerStore(fresh.root, 'test-team');
  assert.deepEqual(
    createFilesystemTeamOwner({ ...fresh.options, store })
      .connect('human')
      .listTasks(),
    []
  );
  const orphan = fixture(t);
  const orphanStore = new TeamOwnerStore(orphan.root, 'test-team');
  write(join(orphan.root, 'tasks', 'test-team', 'legacy.json'), {
    id: 'legacy',
    status: 'pending',
  });
  const before = census(orphan.root);
  assert.throws(
    () => createFilesystemTeamOwner({ ...orphan.options, store: orphanStore }),
    TeamOwnerError
  );
  assert.deepEqual(census(orphan.root), before);
});

test('per-Team admission leaves unrelated legacy Team data untouched and does not adopt it', (t) => {
  const f = fixture(t);
  const unrelated = join(f.root, 'teams', 'unrelated-legacy');
  write(join(unrelated, 'config.json'), { name: 'unrelated-legacy', private: 'Keep' });
  write(join(f.root, 'tasks', 'unrelated-legacy', 'other.json'), {
    id: 'other',
    status: 'pending',
  });
  const before = census(unrelated);
  const taskBefore = readFileSync(join(f.root, 'tasks', 'unrelated-legacy', 'other.json'), 'utf8');
  assert.deepEqual(createFilesystemTeamOwner(f.options).connect('human').listTasks(), []);
  assert.deepEqual(census(unrelated), before);
  assert.equal(
    readFileSync(join(f.root, 'tasks', 'unrelated-legacy', 'other.json'), 'utf8'),
    taskBefore
  );
});

test('a symlinked target namespace is refused before adding owner state or following foreign data', (t) => {
  const f = fixture(t);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-team-namespace-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  write(join(outside, 'legacy.json'), { private: 'Keep' });
  mkdirSync(join(f.root, 'tasks'));
  symlinkSync(outside, join(f.root, 'tasks', 'test-team'), 'dir');
  const outsideBefore = census(outside);
  refusesWithoutWrites(f);
  assert.deepEqual(census(outside), outsideBefore);
});
