import { createTeamProcessComposition } from '../dist/composition/createTeamProcessComposition.js';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import { createQualifiedLinuxProcessApi } from '../dist/process/LinuxRegisteredProcess.js';
import type { RegisteredProcessCapture } from '../dist/process/registeredProcessContracts.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('Linux original executable compares signed Node and unsigned native inode bits exactly',
  { skip: process.platform !== 'linux' || process.arch !== 'x64' }, t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-linux-image-identity-')));
    roots.push(root);
    const artifactPath = join(root, 'registered-process.node'), executablePath = join(root, 'TEST-image');
    writeFileSync(artifactPath, 'TEST mocked native bridge; never execute');
    writeFileSync(executablePath, 'TEST original executable; never execute');
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const originalStat = fs.lstatSync(executablePath, { bigint: true });
    const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync;
    const nativeInode = 0x8000000000000000n;
    let statInode = -nativeInode;
    const identity = { pid: 4100, sessionId: 4100, pidfdId: '1234', pidNamespaceId: '5678',
      bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
    const native = {
      kernelIdentity: () => ({ kernelRelease: '6.18.57', machine: 'x86_64', glibcVersion: '2.39',
        pidfd: true, pidfs: true }),
      captureRoot: () => identity,
      readRootExecutable: () => ({ ...identity, executablePath,
        executableDevice: originalStat.dev.toString(), executableInode: nativeInode.toString() }),
    };
    t.mock.method(process, 'dlopen', (module: { exports: unknown }, path: string) => {
      assert.equal(path, artifactPath);
      module.exports = native;
    });
    t.mock.method(fs, 'lstatSync', ((file, options) => {
      const stat = originalLstat(file, options);
      if (stat && file === executablePath)
        Object.defineProperty(stat, 'ino', { value: typeof stat.ino === 'bigint' ? statInode : Number(statInode) });
      return stat;
    }) as typeof fs.lstatSync);
    t.mock.method(fs, 'fstatSync', ((fd, options) => {
      const stat = originalFstat(fd, options);
      if (stat.dev === originalStat.dev && stat.ino === originalStat.ino)
        Object.defineProperty(stat, 'ino', { value: statInode });
      return stat;
    }) as typeof fs.fstatSync);
    syncBuiltinESMExports();
    try {
      const api = createQualifiedLinuxProcessApi({ path: artifactPath, sha256: hash(artifactPath),
        kernelCapability: 'pidfd-live-v1', libc: { family: 'glibc', minimumVersion: '2.17' } });
      assert.ok(api);
      const child = new ChildProcess();
      Object.defineProperty(child, 'pid', { value: identity.pid });
      api.captureRoot(child, () => true);
      const executable = { path: executablePath, sha256: hash(executablePath) };
      const original = api.readRootExecutable(child, executable);
      assert.equal(original.executableSha256, executable.sha256);
      statInode = nativeInode;
      assert.deepEqual(api.readRootExecutable(child, executable), original, 'the same unsigned representation remains exact');
      for (const replacement of [-nativeInode + 1n, nativeInode + 1n,
        nativeInode + 0x10000000000000000n, -nativeInode - 0x10000000000000000n]) {
        statInode = replacement;
        assert.throws(() => api.readRootExecutable(child, executable), /custody unavailable/,
          'a distinct inode or wider value must not alias the original 64-bit identity');
      }
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      delete createRequire(import.meta.url).cache[artifactPath];
    }
  }
);

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-m19-owner-stage-')));
  roots.push(root);
  const binding = { backendId: 'TEST-backend', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const members = [{ memberId: 'TEST-member', name: 'captain', role: 'lead' as const }];
  const grants = [
    {
      principalId: 'TEST-admin',
      memberName: 'user',
      permissions: ['read', 'admin', 'process.write'] as const,
    },
    {
      principalId: 'TEST-member',
      memberName: 'captain',
      permissions: ['read', 'process.write'] as const,
    },
  ].map((row) => ({ ...row, permissions: [...row.permissions] }));
  const opts = { root, binding, members, grants };
  const owner = createFilesystemTeamOwner(opts);
  let signals = 0,
    absent = false;
  const registrar = {
    backendId: binding.backendId,
    teamId: binding.teamId,
    runId: 'TEST-run',
    memberId: 'TEST-member',
    generation: '1',
  };
  const capture: RegisteredProcessCapture = {
    version: 1,
    registrar,
    root: {
      auditToken: [501, 501, 20, 501, 20, 1000, 100, 2],
      sessionId: 1000,
      bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      osBuild: '24G90',
    },
    target: {
      auditToken: [501, 501, 20, 501, 20, 1001, 100, 3],
      sessionId: 1000,
      bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      osBuild: '24G90',
    },
  };
  const native = {
    capture() {
      return structuredClone(capture);
    },
    observe() {
      return absent ? ('absent' as const) : ('same-live' as const);
    },
    signal() {
      signals++;
      throw Error('TEST lost acknowledgement');
    },
  };
  return {
    root,
    owner,
    opts,
    native,
    registrar,
    signals: () => signals,
    absent: () => {
      absent = true;
    },
  };
}
test('real controller registry and existing command scanner cold-recover original requested stop without redispatch', () => {
  const f = fixture();
  const commands = f.owner.processCommands('TEST-admin', {
    native: f.native,
    registrar: () => f.registrar,
  });
  const before = f.owner.connect('TEST-admin').readSnapshot() as { revision: string };
  const registered = commands.register('TEST-register', { pid: 1001, label: 'TEST service' });
  assert.equal(registered.phase, 'completed');
  assert.notEqual(
    (f.owner.connect('TEST-admin').readSnapshot() as { revision: string }).revision,
    before.revision
  );
  const reference = commands.list()[0]!.processRef;
  const requested = commands.terminate('TEST-original-stop', reference);
  assert.equal(requested.phase, 'held');
  assert.equal(f.signals(), 1);
  const cold = createFilesystemTeamOwner(f.opts).processCommands('TEST-admin', {
    native: f.native,
  });
  assert.equal(cold.pending()[0]!.commandId, 'TEST-original-stop');
  assert.equal(cold.list()[0]!.pendingStop!.originalProcessRef, reference);
  assert.throws(() => cold.terminate('TEST-new-nonce', reference), /hold/);
  assert.equal(f.signals(), 1);
  cold.metadata('TEST-unregister-pending-row', 'unregister', { pid: 1001 });
  const reopened = createFilesystemTeamOwner(f.opts).processCommands('TEST-admin', {
    native: f.native,
  });
  const registry = () =>
    JSON.parse(
      readFileSync(join(f.root, 'teams', f.opts.binding.teamName, 'processes.json'), 'utf8')
    );
  assert.deepEqual(registry(), []);
  assert.equal(
    reopened.list().length,
    1,
    'Original pending native stop remains visible after metadata unregister'
  );
  assert.equal(reopened.list()[0]!.pendingStop!.commandId, 'TEST-original-stop');
  assert.equal(reopened.list()[0]!.pendingStop!.originalProcessRef, reference);
  assert.equal(reopened.list()[0]!.canTerminate, false);
  assert.equal(reopened.lookup('TEST-original-stop')!.state.phase, 'requested');
  assert.deepEqual(registry(), []); // Read-only debt projection did not reinsert unregistered metadata.
  assert.equal(f.signals(), 1);
  f.absent();
  assert.equal(reopened.lookup('TEST-original-stop')!.phase, 'completed');
  assert.deepEqual(reopened.list(), []);
  assert.deepEqual(registry(), []);
  assert.equal(f.signals(), 1);
});
test('actual bound MCP catalog preserves PID/id metadata semantics and excludes all OS termination tools', async () => {
  const f = fixture();
  const process = f.owner.processCommands('TEST-member', {
    native: f.native,
    registrar: () => f.registrar,
  });
  const tools = createTeamMcpTools({ ...f.owner.connect('TEST-member'), process });
  const names = tools.list().map((tool) => tool.name);
  for (const name of [
    'process_register',
    'process_list',
    'process_stop',
    'process_unregister',
    'process_lookup',
  ])
    assert.ok(names.includes(name));
  assert.ok(!names.some((name) => name.includes('terminate') || name.includes('kill')));
  const registered = await tools.callAsync('process_register', {
    commandId: 'TEST-mcp-register',
    pid: 1001,
    label: 'TEST service',
  });
  assert.ok(!JSON.stringify(registered).includes('auditToken'));
  await tools.callAsync('process_stop', { commandId: 'TEST-mcp-metadata-stop', pid: 1001 });
  assert.equal(f.signals(), 0);
  assert.ok(process.list()[0]!.stoppedAt);
  await tools.callAsync('process_unregister', { commandId: 'TEST-mcp-unregister', id: process.list()[0]!.id });
  assert.deepEqual(process.list(), []);
  assert.equal(f.signals(), 0);
});

test('real process composition accepts full stored binding and refuses wrong original owner/scope/extra selectors before native reads', async () => {
  const f = fixture();
  const commands = f.owner.processCommands('TEST-admin', {
    native: f.native,
    registrar: () => f.registrar,
  });
  commands.register('TEST-register', { pid: 1001, label: 'TEST service' });
  const scope = {
    projectId: 'TEST-project',
    workspaceId: 'TEST-workspace',
    teamId: f.opts.binding.teamId,
    runId: 'TEST-run',
    memberId: 'user',
    generation: '1',
  };
  const profile = {
    principalId: 'TEST-admin',
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-revision',
      storageRoot: f.root,
      profileId: 'TEST-profile',
      protocolVersion: 1 as const,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
  };
  let reads = 0;
  const composition = createTeamProcessComposition({
    profile,
    teams: new Map([
      [
        f.opts.binding.teamId,
        {
          definition: { ...f.opts, scope },
          owner: f.owner,
          connection: f.owner.connect('TEST-admin'),
        },
      ],
    ]),
    assertCurrent() {},
    native: {
      observe(_capture) {
        reads++;
        return f.native.observe();
      },
      signal: f.native.signal,
    },
  });
  const bound = { schemaVersion: 1, handleId: 'TEST-original-handle', owner: profile.owner, scope };
  const call = (method: string, binding: unknown, payload: unknown) =>
    composition.methods['team.process.' + method]!.handle({
      binding,
      commandId: 'TEST-control',
      payload,
    });
  const listed = (await call('list', bound, {})) as {
    ok: boolean;
    value: { processRef: string }[];
  };
  assert.equal(listed.ok, true);
  assert.ok(listed.value[0]!.processRef);
  assert.equal(reads, 1);
  for (const binding of [
    { owner: profile.owner, scope },
    { ...bound, path: '/TEST-no-selector' },
    { ...bound, owner: { ...profile.owner, ownerId: 'TEST-foreign' } },
    { ...bound, scope: { ...scope, runId: 'TEST-foreign' } },
  ]) {
    const result = (await call('list', binding, {})) as { ok: boolean };
    assert.equal(result.ok, false);
  }
  assert.equal(reads, 1);
  const invalid = (await call('terminate', bound, { pid: 1001, token: [1] })) as {
    ok: boolean;
    code: string;
    outcome: string;
  };
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'invalid');
  assert.equal(invalid.outcome, 'not-dispatched');
  assert.equal(f.signals(), 0);
});
