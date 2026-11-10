import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import type { RegisteredProcessCapture } from '../dist/process/registeredProcessContracts.js';
import type { OwnerState } from '../dist/team/ownerState.js';

test('destructive lifecycle inspects original process receipt after metadata unregister, without signalling or trusting metadata stop', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-lifecycle-process-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team-id', teamName: 'TEST-team' };
  const store = new TeamOwnerStore(root, binding.teamName);
  const owner = createFilesystemTeamOwner({ root, store, binding,
    members: [{ memberId: 'TEST-lead', name: 'captain', role: 'lead' }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'admin', 'process.write'] }] });
  const registrar = { backendId: binding.backendId, teamId: binding.teamId, runId: 'TEST-run', memberId: 'TEST-lead', generation: '1' };
  const token = { auditToken: [501, 501, 20, 501, 20, 1000, 100, 2], sessionId: 1000,
    bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', osBuild: '24G90' };
  const capture: RegisteredProcessCapture = { version: 1, registrar, root: token,
    target: { ...token, auditToken: [501, 501, 20, 501, 20, 1001, 100, 3] } };
  let absent = false, signals = 0, observations = 0;
  const native = { capture: () => capture, observe() { observations++; return absent ? 'absent' as const : 'same-live' as const; },
    signal() { signals++; return 'accepted' as const; } };
  const commands = owner.processCommands('human', { native, registrar: () => registrar });
  commands.register('TEST-register', { pid: 1001, label: 'TEST-service' });
  commands.metadata('TEST-metadata-stop', 'metadata-stop', { pid: 1001 });
  assert.throws(() => commands.assertReleased(), /hold/);
  commands.metadata('TEST-unregister', 'unregister', { pid: 1001 });
  assert.deepEqual(commands.list(), []);
  assert.throws(() => commands.assertReleased(), /hold/);
  absent = true;
  commands.assertReleased();
  assert.ok(observations > 0); assert.equal(signals, 0);
  store.fenced(() => { const state = store.read<OwnerState>('state.json')!; state.grants[0]!.revoked = true; store.write('state.json', state); });
  assert.throws(() => commands.assertReleased());
});
