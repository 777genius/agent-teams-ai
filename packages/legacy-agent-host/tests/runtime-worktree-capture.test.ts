import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { FileTeamRuntimeBindings } from '../dist/adapters/team/FileTeamRuntimeBindings.js';
import { RuntimeTeamCoordinator } from '../dist/composition/RuntimeTeamCoordinator.js';
import {
  compileRuntimeCapture,
  runtimeCaptureRecipeCandidates,
  runtimeCaptureSourceSchema,
} from '../dist/composition/runtimeCaptureSource.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { effectId } from '../dist/team/identity.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { HostedTeam } from '../dist/composition/MemberEntry.js';
import type { TeamLaunchRecord } from '../dist/team-launch/contracts.js';
import type { Session } from '@agent-teams/provider-session-contracts';
import { canFinalizeWorktreeLaunch } from '../dist/team-launch/worktreePreparation.js';
import { capturedMcpSourceCurrent } from '../dist/mcp-catalog/capturedSource.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-worktree-composition-')));
  const repo = join(root, 'project'),
    storageRoot = join(root, 'storage');
  mkdirSync(repo);
  mkdirSync(storageRoot);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'iliya');
  git(repo, 'config', 'user.email', 'iliyazelenkog@gmail.com');
  writeFileSync(join(repo, 'progress.txt'), 'original\n');
  writeFileSync(
    join(repo, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'TEST-project-tool': {
          command: 'TEST-do-not-execute',
          args: ['exact'],
        },
      },
    })
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'TEST workspace');
  const config = join(root, 'TEST-claude.json');
  writeFileSync(config, '{}');
  const binding = {
    backendId: 'TEST-backend',
    teamId: 'TEST-team',
    teamName: 'test-worktree',
  };
  const definition: TeamHostProfile['teams'][number] = {
    binding,
    scope: {
      projectId: 'TEST-project',
      workspaceId: 'TEST-workspace',
      teamId: binding.teamId,
      runId: 'TEST-base',
      memberId: 'human',
      generation: '0',
    },
    members: [
      { memberId: 'lead', name: 'captain', role: 'lead' },
      {
        memberId: 'alice',
        name: 'alice',
        role: 'member',
        settings: { isolation: 'worktree' },
      },
    ],
    savedSettings: {
      cwd: repo,
      worktree: 'global-test',
      providerId: 'anthropic',
      extraCliArgs: '--max-turns 3',
    },
    grants: [
      {
        principalId: 'human',
        memberName: 'user',
        permissions: ['read', 'admin', 'task.write', 'message.write'],
      },
    ],
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'human',
    teams: [definition],
    owner: {
      ownerId: 'TEST-owner',
      profileId: 'TEST-profile',
      revision: 'TEST-revision',
      storageRoot,
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    runtime: {
      members: [],
      providerTemplates: [
        {
          provider: 'claude',
          teamId: 'TEST-template',
          memberId: 'TEST-template',
          principalId: 'TEST-template',
          sessionId: 'TEST-template',
          generation: 0,
          configRevision: 'TEST-template',
          model: 'TEST-model',
          accountBinding: 'TEST-private-account',
          cwd: repo,
          executable: { path: '/TEST/never-native', sha256: 'a'.repeat(64) },
          environment: { HOME: root, CLAUDE_CONFIG_DIR: root },
          nativeTools: [],
          autoAllowedTools: [],
          mcpCatalogSource: { claudeConfigPath: config },
          limits: {
            queuedInputs: 8,
            inputBytes: 4096,
            outputBytes: 8192,
            outputEvents: 128,
            pendingInteractions: 8,
            timeoutMs: 1000,
          },
        },
      ],
    },
  };
  let runtime: RuntimeTeamCoordinator;
  const owner = createFilesystemTeamOwner({
    root: storageRoot,
    binding,
    members: definition.members.map(({ memberId, name, role, settings }) => ({
      memberId,
      name,
      role,
      ...(settings === undefined ? {} : { settings }),
    })),
    savedSettings: definition.savedSettings!,
    grants: definition.grants.map(({ principalId, memberName, permissions }) => ({
      principalId,
      memberName,
      permissions: [...permissions],
    })),
    assertRosterEditable: (members) => runtime?.assertRosterEditable(binding.teamId, members),
  });
  const connection = owner.connect('human');
  const team: HostedTeam = {
    definition,
    owner,
    connection,
    operatorPrincipalId: 'human',
  };
  const observed: { memberId: string; cwd: string }[] = [];
  let current = true;
  const makeRuntime = () =>
    new RuntimeTeamCoordinator({
      profile,
      teams: new Map([[binding.teamId, team]]),
      assertWriter() {
        if (!current) throw new Error('TEST stale writer');
      },
      createProvider(context) {
        observed.push({
          memberId: context.profile.memberId,
          cwd: context.profile.cwd,
        });
        let end!: () => void;
        const done = new Promise<void>((resolve) => {
          end = resolve;
        });
        const session: Session = {
          sessionRef: `TEST-${observed.length}`,
          submit: async () => ({ ok: false, code: 'unsupported' }),
          observe: async function* () {
            await done;
            yield* [];
          },
          respondToInteraction: async () => ({
            ok: false,
            code: 'unsupported',
          }),
          interrupt: async () => ({ ok: false, code: 'unsupported' }),
          checkReadiness: async () => ({ ok: true, value: undefined }),
          checkpoint: () => ({ ok: false, code: 'unsupported' }),
          close: async () => {
            end();
            return { logicallyClosed: true, cleanup: 'confirmed' };
          },
        };
        return {
          factory: {
            open: async () => ({
              driver: session,
              capabilities: [...context.request.requiredCapabilities],
            }),
          },
          isReady: () => true,
          seal() {},
          cleanup: async () => true,
        };
      },
    });
  runtime = makeRuntime();
  t.after(async () => {
    current = true;
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const roster = connection.readRoster();
  connection.replaceRoster({
    commandId: 'TEST-roster',
    expectedRevision: roster.revision,
    savedSettings: definition.savedSettings!,
    members: [{ name: 'alice', isolation: 'worktree' }],
  });
  const store = new TeamOwnerStore(storageRoot, binding.teamName);
  const record = (commandId: string) =>
    store.read<TeamLaunchRecord>(
      `launches/${runtimeDigest(effectId('team-launch', binding.teamId, commandId))}.json`
    )!;
  return {
    root,
    repo,
    profile,
    team,
    owner,
    connection,
    store,
    observed,
    record,
    runtime: () => runtime,
    capture: (id: string) =>
      runtime.executeLaunch(binding.teamId, 'capture', id, {
        rosterCommandId: 'TEST-roster',
      }),
    stale: () => {
      current = false;
    },
    restart: async () => {
      await runtime.close();
      runtime = makeRuntime();
    },
  };
}

test('actual capture persists worktree intent before Git, then captures real target MCP and native cwd', async (t) => {
  const f = fixture(t),
    commandId = 'TEST-capture-one';
  const launchId = effectId('team-launch', f.team.definition.binding.teamId, commandId);
  const recordPath = join(f.store.directory, 'launches', `${runtimeDigest(launchId)}.json`);
  const marker = join(f.root, 'TEST-during-checkout.json');
  const script = join(f.root, 'TEST-record-proof.mjs');
  writeFileSync(
    script,
    `import {copyFileSync} from 'node:fs'; copyFileSync(${JSON.stringify(recordPath)}, ${JSON.stringify(marker)});`
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const hook = join(f.repo, '.git/hooks/post-checkout');
  git(f.repo, 'config', 'core.hooksPath', join(f.repo, '.git/hooks'));
  writeFileSync(hook, `#!/bin/sh\n${quote(process.execPath)} ${quote(script)}\n`);
  chmodSync(hook, 0o700);
  await f.capture(commandId);
  const during = JSON.parse(readFileSync(marker, 'utf8')) as TeamLaunchRecord;
  assert.equal(
    during.definition.members.length,
    0,
    'future native profiles are not admitted before actual catalog bytes exist'
  );
  assert.equal(during.members.length, 0);
  assert.ok(during.worktreePreparation);
  assert.equal(during.worktreePreparation.completedSourceDigest, undefined);
  assert.ok(during.worktrees?.some((row) => row.state === 'attempted'));
  assert.equal(f.observed.length, 0, 'capture finalizes metadata without opening native members');
  const record = f.record(commandId),
    source = runtimeCaptureSourceSchema.parse(record.definition.capture);
  assert.equal(record.worktreePreparation!.completedSourceDigest, runtimeDigest(source));
  assert.equal(record.definition.members.length, 2);
  assert.deepEqual(
    record.worktrees!.map((row) => row.state),
    ['completed', 'completed']
  );
  const compiled = compileRuntimeCapture(f.profile, f.team, source);
  const pendingStore = new TeamOwnerStore(join(f.root, 'TEST-pending'), f.team.definition.binding.teamName);
  pendingStore.write(`launches/${runtimeDigest(launchId)}.json`, during);
  for (const member of compiled.registration.members) {
    assert.throws(
      () => new FileTeamRuntimeBindings(pendingStore).current(member.delivery),
      { code: 'hold' },
      'unfinished intent must remain unavailable to finalized runtime binding lookup'
    );
    assert.equal(
      new FileTeamRuntimeBindings(f.store).current(member.delivery)!.configurationDigest,
      record.definition.members.find((row) => row.memberId === member.memberId)!.configurationDigest
    );
  }
  const candidates = runtimeCaptureRecipeCandidates(
    f.profile,
    f.team.definition.binding.teamId,
    source
  );
  assert.deepEqual(
    candidates.map((recipe) => recipe.cwd),
    compiled.profiles.map((recipe) => recipe.cwd)
  );
  for (const selected of compiled.profiles) {
    assert.ok(existsSync(join(selected.cwd, '.mcp.json')));
    assert.ok(selected.capturedMcpServers?.['TEST-project-tool']);
    assert.notEqual(selected.cwd, f.repo);
    assert.deepEqual(selected.extraArgs, ['--max-turns', '3']);
    assert.equal(
      record.definition.members.find((row) => row.memberId === selected.memberId)!
        .configurationDigest,
      runtimeDigest(selected)
    );
    await f.runtime().execute(f.team.definition.binding.teamId, 'open', {
      memberId: selected.memberId,
    });
    assert.equal(f.observed.find((row) => row.memberId === selected.memberId)!.cwd, selected.cwd);
    await f.runtime().execute(f.team.definition.binding.teamId, 'stop', {
      memberId: selected.memberId,
    });
  }
  assert.notEqual(compiled.profiles[0]!.cwd, compiled.profiles[1]!.cwd);
  const immutable = (value: TeamLaunchRecord) => ({
    definition: value.definition,
    worktreePreparation: value.worktreePreparation,
    worktrees: value.worktrees,
  });
  const before = immutable(f.record(commandId)),
    opens = f.observed.length;
  await f.capture(commandId);
  assert.deepEqual(
    immutable(f.record(commandId)),
    before,
    'response loss retains original final source and workspace receipts'
  );
  assert.equal(f.observed.length, opens);
});

test('fresh capture after cold relaunch reuses exact owned named/member paths and keeps progress bytes', async (t) => {
  const f = fixture(t);
  await f.capture('TEST-original');
  const first = f.record('TEST-original');
  for (const receipt of first.worktrees!) {
    const cwd = receipt.target.path;
    writeFileSync(join(cwd, 'progress.txt'), 'committed member progress\n');
    git(cwd, 'commit', '-am', 'TEST progress');
    writeFileSync(join(cwd, 'scratch.bin'), Buffer.from([0, 1, 2, 255]));
  }
  const before = first.worktrees!.map((row) => ({
    path: row.target.path,
    inode: lstatSync(row.target.path).ino,
    head: git(row.target.path, 'rev-parse', 'HEAD'),
    status: git(row.target.path, 'status', '--porcelain=v1'),
  }));
  await f.restart();
  await f.capture('TEST-fresh');
  const fresh = f.record('TEST-fresh');
  assert.deepEqual(
    fresh.worktrees!.map((row) => row.target.path),
    before.map((row) => row.path)
  );
  for (const expected of before) {
    assert.equal(lstatSync(expected.path).ino, expected.inode);
    assert.equal(git(expected.path, 'rev-parse', 'HEAD'), expected.head);
    assert.equal(git(expected.path, 'status', '--porcelain=v1'), expected.status);
    assert.deepEqual(readFileSync(join(expected.path, 'scratch.bin')), Buffer.from([0, 1, 2, 255]));
  }
  const intents = runtimeCaptureSourceSchema.parse(fresh.worktreePreparation!.intent);
  for (const row of intents.worktrees!)
    assert.equal(
      row.plan.proof.head,
      before.find((item) => item.path === row.plan.targetPath)!.head
    );
});

test('stale operator admission refuses before Git and does not mint a launch record', async (t) => {
  const f = fixture(t);
  f.stale();
  await assert.rejects(async () => f.capture('TEST-stale'), /TEST stale writer/);
  assert.equal(f.record('TEST-stale'), undefined);
  assert.equal(git(f.repo, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
});

test('replaced target inode is held before the captured native driver can open', async (t) => {
  const f = fixture(t);
  await f.capture('TEST-before-replacement');
  const target = f.record('TEST-before-replacement').worktrees![0]!.target.path;
  git(f.repo, 'worktree', 'move', target, `${target}-TEST-retained`);
  mkdirSync(target);
  writeFileSync(join(target, 'foreign.txt'), 'foreign replacement bytes');
  await assert.rejects(
    f.runtime().execute(f.team.definition.binding.teamId, 'open', { memberId: 'lead' }),
    { reason: 'owned-worktree-identity-changed' }
  );
  assert.equal(f.observed.length, 0, 'the native factory must never receive the replaced cwd');
  assert.equal(readFileSync(join(target, 'foreign.txt'), 'utf8'), 'foreign replacement bytes');
});

test('cold replay after completed-receipt ACK loss keeps original plans when base HEAD moves', async (t) => {
  const f = fixture(t),
    command = 'TEST-lost-worktree-ack';
  const originalWrite = TeamOwnerStore.prototype.write;
  let lost = false;
  TeamOwnerStore.prototype.write = function (name, value) {
    originalWrite.call(this, name, value);
    const record = value as Partial<TeamLaunchRecord>;
    if (
      !lost &&
      name.startsWith('launches/') &&
      record.worktreePreparation &&
      record.worktrees?.some((row) => row.state === 'completed')
    ) {
      lost = true;
      throw new Error('TEST durable worktree completion ACK lost');
    }
  };
  try {
    await assert.rejects(f.capture(command), /TEST durable worktree completion ACK lost/);
  } finally {
    TeamOwnerStore.prototype.write = originalWrite;
  }
  const interrupted = f.record(command),
    originalPlans = runtimeCaptureSourceSchema.parse(
      interrupted.worktreePreparation!.intent
    ).worktrees!;
  assert.equal(interrupted.definition.members.length, 0);
  assert.equal(f.owner.runtimeCaptures('human').length, 0);
  assert.equal(f.observed.length, 0);
  writeFileSync(join(f.repo, 'progress.txt'), 'later base commit\n');
  git(f.repo, 'commit', '-am', 'TEST base advanced after original receipt');
  await f.restart();
  await f.capture(command);
  const completed = f.record(command);
  assert.deepEqual(
    runtimeCaptureSourceSchema.parse(completed.worktreePreparation!.intent).worktrees,
    originalPlans
  );
  for (const row of completed.worktrees!) {
    const original = originalPlans.find((plan) => plan.plan.slotId === row.binding!.slotId)!;
    assert.equal(git(row.target.path, 'rev-parse', 'HEAD'), original.plan.capturedCommit);
    assert.equal(row.target.inode, lstatSync(row.target.path).ino);
  }
  assert.equal(f.owner.runtimeCaptures('human').length, 1);
});

test('historical capture remains readable while a fresh cold launch captures the edited owned catalog', async (t) => {
  const f = fixture(t),
    command = 'TEST-immutable-catalog';
  await f.capture(command);
  const original = f.record(command),
    target = original.worktrees![0]!.target.path;
  writeFileSync(
    join(target, '.mcp.json'),
    JSON.stringify({
      mcpServers: { 'TEST-changed': { command: 'TEST-never-execute' } },
    })
  );
  await f.capture(command);
  await f.restart();
  const historical = compileRuntimeCapture(
    f.profile,
    f.team,
    runtimeCaptureSourceSchema.parse(original.definition.capture)
  );
  assert.ok(
    historical.profiles.every((profile) => profile.capturedMcpServers?.['TEST-project-tool'])
  );
  assert.ok(historical.profiles.every((profile) => !capturedMcpSourceCurrent(profile)));
  await f.capture('TEST-edited-catalog-new-command');
  const fresh = compileRuntimeCapture(
    f.profile,
    f.team,
    runtimeCaptureSourceSchema.parse(f.record('TEST-edited-catalog-new-command').definition.capture)
  );
  assert.ok(fresh.profiles.every((profile) => profile.capturedMcpServers?.['TEST-changed']));
  assert.ok(fresh.profiles.every((profile) => capturedMcpSourceCurrent(profile)));
  assert.deepEqual(f.record(command).definition, original.definition);
  assert.deepEqual(f.record(command).worktreePreparation, original.worktreePreparation);
  assert.equal(f.owner.runtimeCaptures('human').length, 2);
  assert.equal(f.observed.length, 0);
});

test('preallocation completion preserves original settings even when workspace receipts are complete', async (t) => {
  const f = fixture(t);
  await f.capture('TEST-original-settings');
  const final = f.record('TEST-original-settings'),
    pending = structuredClone(final);
  delete pending.worktreePreparation!.completedSourceDigest;
  pending.definition = {
    launchId: final.definition.launchId,
    rosterRevision: 'TEST-preparation',
    capture: pending.worktreePreparation!.intent,
    members: [],
  };
  pending.fingerprint = runtimeDigest(pending.definition);
  pending.members = [];
  assert.equal(canFinalizeWorktreeLaunch(pending, final.definition), true);
  const changed = structuredClone(final.definition);
  const source = runtimeCaptureSourceSchema.parse(changed.capture);
  source.savedSettings.prompt = 'changed after workspace preparation';
  changed.capture = JSON.parse(JSON.stringify(source));
  assert.throws(() => canFinalizeWorktreeLaunch(pending, changed), {
    reason: 'worktree-capture-choices-changed',
  });
  assert.equal(f.observed.length, 0);
});

test('close drains its actual in-flight Git capture and sealed authority prevents final publication', async (t) => {
  const f = fixture(t);
  const marker = join(f.root, 'TEST-checkout-entered');
  const release = join(f.root, 'TEST-checkout-release');
  const hook = join(f.repo, '.git', 'hooks', 'post-checkout');
  git(f.repo, 'config', 'core.hooksPath', join(f.repo, '.git', 'hooks'));
  writeFileSync(
    hook,
    `#!${process.execPath}\nconst fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'TEST-entered');
const deadline = Date.now() + 10000;
while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
if (!fs.existsSync(${JSON.stringify(release)})) process.exit(2);
`,
    { mode: 0o700 }
  );
  const pending = f.capture('TEST-close-during-checkout');
  let failure: unknown;
  void pending.catch((error: unknown) => {
    failure = error;
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && !failure && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    existsSync(marker),
    `actual Git checkout reached its original TEST hook: ${String(failure)}`
  );
  let closed = false;
  const closing = f
    .runtime()
    .close()
    .then(() => {
      closed = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'close retains the original in-flight capture obligation');
  writeFileSync(release, 'TEST-release');
  await assert.rejects(pending, { reason: 'sealed' });
  await closing;
  assert.equal(f.owner.runtimeCaptures('human').length, 0);
  assert.equal(f.record('TEST-close-during-checkout').members.length, 0);
  assert.equal(f.observed.length, 0);
});
