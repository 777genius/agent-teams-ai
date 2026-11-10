import { createTeamProcessComposition } from '../dist/composition/createTeamProcessComposition.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { createTeamMcpTools } from '../dist/mcp/tools.js';
import type { RegisteredProcessCapture } from '../dist/process/registeredProcessContracts.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
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
test('actual bound MCP catalog preserves PID/id metadata semantics and excludes all OS termination tools', () => {
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
  const registered = tools.call('process_register', {
    commandId: 'TEST-mcp-register',
    pid: 1001,
    label: 'TEST service',
  });
  assert.ok(!JSON.stringify(registered).includes('auditToken'));
  tools.call('process_stop', { commandId: 'TEST-mcp-metadata-stop', pid: 1001 });
  assert.equal(f.signals(), 0);
  assert.ok(process.list()[0]!.stoppedAt);
  tools.call('process_unregister', { commandId: 'TEST-mcp-unregister', id: process.list()[0]!.id });
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
