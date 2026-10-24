import { describe, expect, it, vi } from 'vitest';
import { createHostSavedMemberMutations } from '../../../src/features/agent-backend/renderer/createHostSavedMemberMutations';
import type { AgentBackendApi, BackendOperationRequest, BackendOperationResult } from '../../../src/features/agent-backend/contracts/operations';
import type { BackendHandle } from '../../../src/features/agent-backend/contracts';
const revision = 'a'.repeat(64), next = 'b'.repeat(64);
const handle: BackendHandle = { handleId: 'TEST-owner' };
function fixture() {
  let current = true;
  const configuration = { revision, members: [{ memberId: 'lead', name: 'team-lead', role: 'lead', settings: {} },
    { memberId: 'alice', name: 'alice', role: 'member', settings: { providerId: 'codex', model: 'TEST-model' } }],
    removedMembers: [{ memberId: 'bob', name: 'bob', removedAt: 'TEST-time', settings: { providerId: 'opencode', model: 'TEST-other' } }] };
  const invoke = vi.fn(async (request: BackendOperationRequest): Promise<BackendOperationResult> =>
    request.operation === 'team.roster.read' ? { ok: true, value: configuration as never }
      : { ok: true, value: { commandId: request.commandId, revision: next } });
  const api = createHostSavedMemberMutations({ backend: { invoke } as unknown as AgentBackendApi,
    captureScope: () => () => current, resolve: async () => ({ handle }), invalidateReads: vi.fn() });
  return { api, invoke, configuration, invalidate: () => { current = false; } };
}
describe('existing saved-member API uses the original complete roster CAS', () => {
  it('restores retained settings only and lets the existing owner retain stable member identity', async () => {
    const f = fixture();
    await f.api.restoreMember('TEST-key', ' BOB ');
    const effect = f.invoke.mock.calls.find(([request]) => request.operation === 'team.roster.replace')![0];
    expect(effect.handle).toEqual(handle);
    expect(effect.payload).toEqual({ expectedRevision: revision, members: [
      { name: 'alice', providerId: 'codex', model: 'TEST-model' }, { name: 'bob', providerId: 'opencode', model: 'TEST-other' },
    ] });
    expect(JSON.stringify(effect.payload)).not.toMatch(/memberId|removedAt|agentId|joinedAt/);
  });
  it('removes only selected saved teammate and refuses lead or re-adding a removed identity', async () => {
    const f = fixture();
    await f.api.removeMember('TEST-key', 'alice');
    expect(f.invoke.mock.calls[1]![0].payload).toEqual({ expectedRevision: revision, members: [] });
    await expect(f.api.removeMember('TEST-key', 'team-lead')).rejects.toThrow();
    await expect(f.api.addMember('TEST-key', { name: 'bob' })).rejects.toThrow();
    expect(f.invoke.mock.calls.filter(([request]) => request.operation === 'team.roster.replace')).toHaveLength(1);
  });
  it('lost reply uses read-only lookup with the same command, handle and full captured replacement', async () => {
    const f = fixture();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async request => {
      if (request.operation === 'team.roster.replace') throw new Error('TEST reply lost');
      if (request.operation === 'team.roster.lookup') return { ok: true, value: { commandId: request.commandId, revision: next } };
      return original(request);
    });
    await f.api.addMember('TEST-key', { name: 'carol', providerId: 'gemini', model: 'TEST-new' });
    const [, effect, lookup] = f.invoke.mock.calls.map(([request]) => request);
    expect(lookup!.commandId).toBe(effect!.commandId);
    expect(lookup!.handle).toEqual(effect!.handle);
    expect(lookup!.payload).toEqual({ expected: effect!.payload });
    expect(f.invoke.mock.calls.filter(([request]) => request.operation === 'team.roster.replace')).toHaveLength(1);
  });
  it('context switch after saved configuration read cannot dispatch a mutation', async () => {
    const f = fixture(), original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async request => { const response = await original(request); f.invalidate(); return response; });
    await expect(f.api.removeMember('TEST-key', 'alice')).rejects.toThrow(/context-changed/);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
});
