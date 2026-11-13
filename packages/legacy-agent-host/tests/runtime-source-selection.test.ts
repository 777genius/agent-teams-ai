import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { RuntimeSourceIndex } from '../dist/composition/RuntimeSourceIndex.js';
import {
  captureRuntimeSource,
  compileRuntimeCapture,
} from '../dist/composition/runtimeCaptureSource.js';
import { createTeamHost } from '../dist/composition/TeamHost.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type {
  RuntimeSourceCandidate,
  RuntimeSourceGrant,
  RuntimeSourcePublication,
  RuntimeSourceSummary,
} from '../dist/composition/runtimeSourceContracts.js';
import type { TeamRosterConfiguration } from '../dist/team/rosterContracts.js';
import type { TestContext } from 'node:test';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-runtime-source-')));
  mkdirSync(join(root, '.claude'), { mode: 0o700 });
  const bytes = '#!/bin/sh\nprintf TEST-source-fixture\n';
  const executable = (name: string) => {
    const path = join(root, name);
    writeFileSync(path, bytes, { mode: 0o700 });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const original = executable('TEST-original'),
    replacement = executable('TEST-replacement');
  const environment = {
    HOME: root,
    PATH: '/usr/bin',
    TEST_AUTH_VALUE: 'TEST-do-not-persist-secret',
  };
  const scope = {
    projectId: 'TEST-host-project',
    workspaceId: 'TEST-host-workspace',
    teamId: 'TEST-team',
    runId: 'TEST-run',
    memberId: 'TEST-human',
    generation: '0',
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-owner-v1',
      storageRoot: root,
      profileId: 'TEST-bootstrap',
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    management: [
      {
        provider: 'claude',
        sdkRevision: '0.3.305',
        profileId: 'TEST-management',
        configRevision: 'TEST-config',
        configNamespace: 'native-default',
        accountBinding: 'TEST-account',
        cwd: root,
        environment,
        executable: original,
        timeoutMs: 1000,
      },
    ],
    runtime: {
      members: [
        {
          provider: 'claude',
          teamId: 'TEST-team',
          memberId: 'lead',
          principalId: 'TEST-agent',
          sessionId: 'TEST-session',
          generation: 0,
          configRevision: 'TEST-runtime-config',
          model: 'TEST-model',
          accountBinding: 'TEST-account',
          cwd: root,
          environment,
          executable: original,
          nativeTools: ['Read'],
          autoAllowedTools: ['Read'],
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
    teams: [
      {
        binding: { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-source-team' },
        scope,
        members: [{ memberId: 'lead', name: 'captain', role: 'lead' }],
        grants: [],
      },
    ],
  };
  const grant: RuntimeSourceGrant = {
    targetId: 'c'.repeat(64),
    ownerId: profile.owner.ownerId,
    ownerRevision: profile.owner.revision,
    contextId: 'TEST-desktop-context',
    projectPath: root,
    runtimeId: 'claude',
    profileId: 'TEST-management',
    configRevision: 'TEST-config',
    teamScopes: [
      { teamId: scope.teamId, projectId: scope.projectId, workspaceId: scope.workspaceId },
    ],
  };
  const roster: TeamRosterConfiguration = {
    revision: 'd'.repeat(64),
    savedSettings: { cwd: root },
    removedMembers: [],
    members: [{ memberId: 'lead', name: 'captain', role: 'lead', settings: {} }],
  };
  const candidate: RuntimeSourceCandidate = { sourceKind: 'app-managed', executable: replacement };
  return {
    root,
    profile,
    grant,
    candidate,
    original,
    replacement,
    roster,
    team: { definition: profile.teams[0]! },
  };
}

function leased(t: TestContext) {
  const f = fixture();
  let lease = acquireProfileWriterLease(f.root);
  t.after(() => {
    lease.release();
    rmSync(f.root, { recursive: true, force: true });
  });
  const open = () => {
    const captured = lease;
    return new RuntimeSourceIndex(f.profile, () => captured.assertCurrent());
  };
  let index = open();
  return {
    ...f,
    get index() {
      return index;
    },
    restart() {
      lease.release();
      lease = acquireProfileWriterLease(f.root);
      index = open();
    },
  };
}

test('publication pins new captures while seed and retained captures replay unchanged after a cold restart', async (t) => {
  const f = leased(t),
    initial = f.index.current({ grant: f.grant });
  const seed = captureRuntimeSource(f.profile, f.team, 'TEST-seed', 'TEST-roster', f.roster, {
    deferMcp: true,
  });
  const seedJson = JSON.stringify(seed);
  assert.equal(seed.recipeSources, undefined);
  const input = {
    grant: f.grant,
    commandId: 'TEST-publish-1',
    expectedRevision: initial.revision,
    candidate: f.candidate,
  };
  const first = await f.index.publish(input, () => {});
  assert.equal(first.phase, 'published');
  assert.deepEqual(
    await f.index.publish(input, () => assert.fail('replay must not re-admit')),
    first
  );
  const selected = captureRuntimeSource(f.profile, f.team, 'TEST-new', 'TEST-roster', f.roster, {
    deferMcp: true,
    sources: f.index,
  });
  assert.equal(selected.recipeSources?.[0]?.revision, first.selection?.revision);
  assert.throws(() => f.index.resolveRecipe(selected.recipeSources![0]!,
    { ...f.team.definition.scope, teamId: 'TEST-foreign-team' }, f.root, f.profile.runtime!.members[0]!), { code: 'held' });
  const next = await f.index.publish(
    {
      grant: f.grant,
      commandId: 'TEST-publish-2',
      expectedRevision: first.selection!.revision,
      candidate: { ...f.candidate, executable: f.original, sourceKind: 'override' },
    },
    () => {}
  );
  await assert.rejects(
    f.index.publish({ ...input, commandId: 'TEST-stale' }, () => {}),
    { code: 'conflict' }
  );
  assert.deepEqual(f.index.lookup({ grant: f.grant, commandId: input.commandId }), first);
  f.restart();
  assert.equal(f.index.current({ grant: f.grant }).revision, next.selection!.revision);
  assert.deepEqual(
    compileRuntimeCapture(f.profile, f.team, selected, 'model-preflight', f.index).profiles[0]!
      .executable,
    f.replacement
  );
  assert.deepEqual(
    compileRuntimeCapture(f.profile, f.team, seed, 'model-preflight', f.index).profiles[0]!
      .executable,
    f.original
  );
  assert.equal(JSON.stringify(seed), seedJson);
  assert.equal(f.index.retained({ grant: f.grant }).length, 3);
  assert.equal(
    f.index.retainedManagementProfiles()[0]!.environment.TEST_AUTH_VALUE,
    'TEST-do-not-persist-secret'
  );
  assert.equal(
    readFileSync(join(f.root, 'runtime-sources', 'index.json'), 'utf8').includes(
      'TEST-do-not-persist-secret'
    ),
    false
  );
  rmSync(join(f.root, 'runtime-sources', 'index.json'));
  assert.throws(() => f.index.current({ grant: f.grant }), { code: 'held' });
  assert.throws(() => f.restart(), { code: 'held' }, 'missing published index cannot fall back to the seed after restart');
});

test('member project source is captured before preparation and retained through cold compile', async (t) => {
  const f = leased(t), workerCwd = join(f.root, 'TEST-worker-project');
  mkdirSync(workerCwd);
  f.profile.management!.push({ ...f.profile.management![0]!, cwd: workerCwd,
    profileId: 'TEST-worker-management', configRevision: 'TEST-worker-config' });
  f.profile.runtime!.members.push({ ...f.profile.runtime!.members[0]!, memberId: 'worker',
    principalId: 'TEST-worker-agent', sessionId: 'TEST-worker-session', cwd: workerCwd });
  f.profile.teams[0]!.members.push({ memberId: 'worker', name: 'worker', role: 'member' });
  f.roster.members.push({ memberId: 'worker', name: 'worker', role: 'member', settings: { cwd: workerCwd } });
  const workerGrant = { ...f.grant, targetId: 'e'.repeat(64), projectPath: workerCwd,
    profileId: 'TEST-worker-management', configRevision: 'TEST-worker-config' };
  const lead = await f.index.publish({ grant: f.grant, commandId: 'TEST-lead-project',
    expectedRevision: f.index.current({ grant: f.grant }).revision, candidate: f.candidate }, () => {});
  const worker = await f.index.publish({ grant: workerGrant, commandId: 'TEST-worker-project',
    expectedRevision: f.index.current({ grant: workerGrant }).revision,
    candidate: { sourceKind: 'override', executable: f.original } }, () => {});
  const captured = captureRuntimeSource(f.profile, f.team, 'TEST-project-capture', 'TEST-roster', f.roster,
    { deferMcp: true, sources: f.index });
  assert.deepEqual(captured.recipeSources, [
    { memberId: 'lead', sourceId: f.grant.targetId, revision: lead.selection!.revision },
    { memberId: 'worker', sourceId: workerGrant.targetId, revision: worker.selection!.revision },
  ]);
  await f.index.publish({ grant: workerGrant, commandId: 'TEST-worker-new-default',
    expectedRevision: worker.selection!.revision, candidate: f.candidate }, () => {});
  f.restart();
  const profiles = compileRuntimeCapture(f.profile, f.team, captured, 'model-preflight', f.index).profiles;
  assert.deepEqual(profiles.map(row => ({ cwd: row.cwd, executable: row.executable })), [
    { cwd: f.root, executable: f.replacement }, { cwd: workerCwd, executable: f.original },
  ]);
});

test('source admission refuses scope widening, changed bytes and arbitrary configuration without changing current', async (t) => {
  const f = leased(t),
    initial = f.index.current({ grant: f.grant });
  const input = {
    grant: f.grant,
    commandId: 'TEST-refuse',
    expectedRevision: initial.revision,
    candidate: f.candidate,
  };
  for (const grant of [
    { ...f.grant, runtimeId: 'codex' },
    { ...f.grant, projectPath: tmpdir() },
    {
      ...f.grant,
      teamScopes: [{ teamId: 'foreign', projectId: 'foreign', workspaceId: 'foreign' }],
    },
  ])
    await assert.rejects(
      f.index.publish({ ...input, grant }, () => {}),
      { code: 'conflict' }
    );
  await assert.rejects(
    f.index.publish(
      { ...input, candidate: { ...f.candidate, environment: { HOME: '/foreign' } } },
      () => {}
    )
  );
  writeFileSync(f.replacement.path, '#!/bin/sh\nexit 2\n');
  await assert.rejects(
    f.index.publish(input, () => assert.fail('unverified bytes cannot be admitted'))
  );
  assert.deepEqual(f.index.current({ grant: f.grant }), initial);
  assert.deepEqual(f.index.lookup({ grant: f.grant, commandId: input.commandId }),
    { commandId: input.commandId, phase: 'held', reason: 'source-changed' });
  assert.equal(new FileManagementCommandStore(f.root).read(input.commandId)?.resourceHeld, false);
  assert.equal(
    f.index.currentForRecipe(
      { ...f.profile.teams[0]!.scope, teamId: 'foreign' },
      f.root,
      f.profile.runtime!.members[0]!
    ),
    undefined
  );
});

test('a crash after pointer publication recovers the original receipt without selecting current again', async (t) => {
  const f = leased(t),
    current = f.index.current({ grant: f.grant });
  const write = FileManagementCommandStore.prototype.write;
  const fault = t.mock.method(
    FileManagementCommandStore.prototype,
    'write',
    function (this: FileManagementCommandStore, record: Parameters<typeof write>[0]) {
      if (record.kind === 'runtime.source' && record.phase === 'published')
        throw new Error('TEST crash before receipt completion');
      write.call(this, record);
    }
  );
  const input = {
    grant: f.grant,
    commandId: 'TEST-interrupted-publication',
    expectedRevision: current.revision,
    candidate: f.candidate,
  };
  await assert.rejects(
    f.index.publish(input, () => {}),
    /TEST crash/
  );
  fault.mock.restore();
  f.restart();
  const recovered = f.index.lookup({ grant: f.grant, commandId: input.commandId });
  assert.equal(recovered?.phase, 'published');
  assert.equal(f.index.current({ grant: f.grant }).revision, recovered?.selection?.revision);
  assert.deepEqual(
    await f.index.publish(input, () => assert.fail('recovery cannot re-admit')),
    recovered
  );
  assert.equal(new FileManagementCommandStore(f.root).read(input.commandId)?.phase, 'published');
});

test('private Host RPC publishes and restores sources and admits existing Skills and extension targets', async (t) => {
  const f = fixture(),
    profile = { ...f.profile, teams: [] };
  delete profile.runtime;
  const grant = { ...f.grant, teamScopes: [] };
  let input: PassThrough,
    output: PassThrough,
    sequence = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let host!: ReturnType<typeof createTeamHost>;
  function start() {
    input = new PassThrough();
    output = new PassThrough();
    let pending = '';
    output.on('data', (chunk) => {
      pending += String(chunk);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const frame = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        const target = waiting.get(frame.id);
        if (target) {
          waiting.delete(frame.id);
          if (frame.error) target.reject(new Error(frame.error.message));
          else target.resolve(frame.result);
        }
      }
    });
    host = createTeamHost(profile, { input, output });
  }
  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`TEST RPC timeout: ${method}`)), 5000);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  start();
  t.after(async () => {
    await host.dispose();
    rmSync(f.root, { recursive: true, force: true });
  });
  const handshake = await rpc<{ capabilities: string[] }>('host.handshake', { protocolVersion: 1 });
  assert.ok(handshake.capabilities.includes('runtime.sources'));
  const current = await rpc<{ ok: true; value: RuntimeSourceSummary }>('runtime.source.current', {
    grant,
  });
  const published = await rpc<{ ok: true; value: RuntimeSourcePublication }>(
    'runtime.source.publish',
    {
      grant,
      commandId: 'TEST-private-publish',
      expectedRevision: current.value.revision,
      candidate: f.candidate,
    }
  );
  assert.equal(published.ok, true);
  const selected = published.value.selection!;
  for (const identity of [current.value, selected]) {
    const skills = await rpc<{ ok: boolean }>('management.skills.capture', {
      profileId: identity.profileId,
      configRevision: identity.configRevision,
      scope: 'project',
      rootKind: 'claude',
    });
    assert.equal(skills.ok, true, 'both old and new profile IDs serve existing Skills');
    const extensions = await rpc<{ ok: boolean }>('management.extension.capture', {
      profileId: identity.profileId,
      configRevision: identity.configRevision,
      panel: 'mcp',
      scope: 'project',
    });
    assert.equal(extensions.ok, true, 'both old and new profile IDs serve existing extensions');
  }
  await host.dispose();
  start();
  await rpc('host.handshake', { protocolVersion: 1 });
  const restored = await rpc<{ ok: true; value: RuntimeSourceSummary }>('runtime.source.current', {
    grant,
  });
  assert.deepEqual(restored.value, selected);
  assert.deepEqual(
    await rpc('runtime.source.lookup', { grant, commandId: 'TEST-private-publish' }),
    published
  );
});
