import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';
import { expect, it, vi } from 'vitest';
import { createCapturedHostBackup } from '../../../src/features/agent-backend/main/application/createCapturedHostBackup';
import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import { readCapturedTeamRetirements } from '../../../src/features/agent-backend/main/infrastructure/readCapturedTeamRetirements';
import type { BackendOwnerBinding } from '../../../src/features/agent-backend/main/application/backendBinding';

it('startup/snapshot requests use only immutable original handles and current-context guard', async () => {
  const handles = [{ handleId: 'TEST-original' }], guard = { isCurrent: () => true };
  const request = vi.fn<BackendOwnerRouter['request']>(async () => ({ ok: true, value: { copied: 2, restored: 1, heldCount: 0 } }));
  const captured = createCapturedHostBackup({ handles, guard, router: { request } });
  handles[0]!.handleId = 'TEST-replacement';
  await captured.run('reconcile');
  await captured.run('snapshot');
  expect(request.mock.calls.map(([handle, envelope]) => [handle.handleId, envelope.method, envelope.guard])).toEqual([
    ['TEST-original', 'team.backup.reconcile', guard], ['TEST-original', 'team.backup.snapshot', guard],
  ]);
});
it('context change after first reply cannot route remaining backup work into another owner', async () => {
  let current = true;
  const request = vi.fn<BackendOwnerRouter['request']>(async () => { current = false; return { ok: true, value: { copied: 1, restored: 0, heldCount: 0 } }; });
  const captured = createCapturedHostBackup({ handles: [{ handleId: 'TEST-A' }, { handleId: 'TEST-B' }], guard: { isCurrent: () => current }, router: { request } });
  await expect(captured.run('snapshot')).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it('unknown/malformed/held backup outcomes never retry or claim completed backup', async () => {
  const results: JsonValue[] = [{ ok: false, code: 'hold', outcome: 'unknown' }, { ok: true, value: { copied: 1, restored: 0, heldCount: 1 } },
    { ok: true, value: { copied: 1, restored: null, heldCount: 0 } }];
  for (const result of results) {
    const request = vi.fn<BackendOwnerRouter['request']>(async () => result);
    const captured = createCapturedHostBackup({ handles: [{ handleId: 'TEST-original' }], guard: { isCurrent: () => true }, router: { request } });
    await expect(captured.run('snapshot')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  }
});
it('retired display read captures original Host owner and refuses stale context or malformed receipt inventory', async () => {
  const owner = { ownerId: 'TEST-owner', revision: '1', storageRoot: '/TEST-private', profileId: 'TEST-profile', protocolVersion: 1,
    buildId: 'TEST-build', nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) } satisfies BackendOwnerBinding;
  let current = true;
  const request = vi.fn(async () => ({ ok: true, value: { teamIds: ['TEST-purged-team'] } }));
  const options = { owner, contextId: 'TEST-context', client: { request }, start: async () => {}, available: () => true, guard: { isCurrent: () => current } };
  const pending = readCapturedTeamRetirements(options); owner.profileId = 'TEST-replacement';
  expect(await pending).toEqual(['TEST-purged-team']);
  expect(request.mock.calls[0]).toEqual(['team.lifecycle.retired.read', { owner: { ...owner, profileId: 'TEST-profile' }, contextId: 'TEST-context' }, { control: true }]);
  current = false;
  await expect(readCapturedTeamRetirements(options)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
  current = true;
  await expect(readCapturedTeamRetirements({ ...options, client: { request: async () => ({ ok: true, value: { teamIds: ['duplicate', 'duplicate'] } }) } })).rejects.toThrow();
});
