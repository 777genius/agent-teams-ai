import { expect, it, vi } from 'vitest';
import { createHostProductLifecycleApi } from '../../../src/features/agent-backend/renderer/createHostProductLifecycleApi';
import { projectTeamLifecycle } from '../../../src/features/agent-backend/main/adapters/output/projectTeamLifecycle';
import type { AgentBackendApi, BackendOperationRequest, BackendOperationResult } from '../../../src/features/agent-backend/contracts/operations';
const revision = 'a'.repeat(64), next = 'b'.repeat(64), handle = { handleId: 'TEST-owner' };
function fixture(run: (request: BackendOperationRequest) => Promise<BackendOperationResult>) {
  let current = true;
  const invoke = vi.fn(run), invalidateReads = vi.fn();
  const api = createHostProductLifecycleApi({ backend: { invoke } as Pick<AgentBackendApi, 'invoke'> as AgentBackendApi,
    captureScope: () => () => current, resolve: async () => ({ handle }), invalidateReads });
  return { api, invoke, invalidateReads, invalidate: () => { current = false; } };
}
it('trash lost reply reads only same original owner/command/full CAS intent; no second effect', async () => {
  const f = fixture(async request => {
    if (request.operation === 'team.lifecycle.read') return { ok: true, value: { kind: 'team_lifecycle', revision, deletedAt: null, cleanupPending: false } };
    if (request.operation === 'team.lifecycle.change') throw new Error('TEST response lost after durable original decision');
    return { ok: true, value: { kind: 'team_lifecycle', commandId: request.commandId, revision: next, deletedAt: '2026-10-23T00:00:00.000Z', cleanupPending: true } };
  });
  await f.api.deleteTeam('TEST-key');
  const effect = f.invoke.mock.calls[1]![0], lookup = f.invoke.mock.calls[2]![0];
  expect(effect.operation).toBe('team.lifecycle.change'); expect(lookup.operation).toBe('team.lifecycle.lookup');
  expect(lookup.commandId).toBe(effect.commandId); expect(lookup.handle).toEqual(effect.handle);
  expect(lookup.payload).toEqual({ expected: effect.payload });
  expect(f.invoke.mock.calls.filter(([r]) => r.operation === 'team.lifecycle.change')).toHaveLength(1);
});
it('queue discard captures exact displayed IDs before await and unresolved original receipt never removes another row or retries', async () => {
  const f = fixture(async request => ({ ok: true, value: { kind: 'queued_discard', commandId: request.commandId, phase: 'prepared' } }));
  const ids = ['TEST-shown']; const running = f.api.discardQueuedUserMessages('TEST-key', 'alice', ids); ids.push('TEST-arrived-later');
  await expect(running).rejects.toMatchObject({ outcome: 'unknown' });
  expect(f.invoke.mock.calls).toHaveLength(2);
  expect(f.invoke.mock.calls[0]![0].payload).toEqual({ member: 'alice', messageIds: ['TEST-shown'] });
  expect(f.invoke.mock.calls[1]![0].payload).toEqual({ expected: { member: 'alice', messageIds: ['TEST-shown'] } });
});
it('context change after uncertain write refuses lookup/rebind; Main projection rejects private or wrong-command rows', async () => {
  const f = fixture(async () => { f.invalidate(); throw new Error('TEST scope changed'); });
  await expect(f.api.discardQueuedUserMessages('TEST-key', 'alice', ['TEST-shown'])).rejects.toMatchObject({ outcome: 'unknown' });
  expect(f.invoke.mock.calls).toHaveLength(1);
  expect(() => projectTeamLifecycle({ kind: 'queued_discard', commandId: 'TEST-wrong', phase: 'completed', discarded: 1, remainingQueued: 0 }, 'team.queue.discard', 'TEST-original')).toThrow();
  expect(() => projectTeamLifecycle({ kind: 'queued_discard', commandId: 'TEST-original', phase: 'prepared', targets: ['TEST-private-native-scope'] }, 'team.queue.lookup', 'TEST-original')).toThrow();
});
it('permanent deletion lost reply uses original retained lookup without retry or same-name resolution', async () => {
  const transactionId = '70b7498f-f097-428c-ad20-b8d8d6a93510';
  const f = fixture(async request => {
    if (request.operation === 'team.lifecycle.read') return { ok: true, value: { kind: 'team_lifecycle', revision, deletedAt: '2026-10-23T00:00:00.000Z', cleanupPending: false } };
    if (request.operation === 'team.lifecycle.purge') throw new Error('TEST namespace removed; original response lost');
    return { ok: true, value: { kind: 'team_purge', commandId: request.commandId, transactionId, phase: 'deleted' } };
  });
  await f.api.permanentlyDeleteTeam('TEST-original-key');
  const effect = f.invoke.mock.calls[1]![0], lookup = f.invoke.mock.calls[2]![0];
  expect(effect.operation).toBe('team.lifecycle.purge'); expect(lookup.operation).toBe('team.lifecycle.purge.lookup');
  expect(lookup.commandId).toBe(effect.commandId); expect(lookup.handle).toEqual(effect.handle);
  expect(lookup.payload).toEqual({ expected: { expectedRevision: revision } });
  expect(f.invoke.mock.calls.filter(([request]) => request.operation === 'team.lifecycle.purge')).toHaveLength(1);
  expect(projectTeamLifecycle({ kind: 'team_purge', commandId: effect.commandId, transactionId, phase: 'deleted' }, lookup.operation, effect.commandId)).toEqual({ kind: 'team_purge', commandId: effect.commandId, transactionId, phase: 'deleted' });
  expect(() => projectTeamLifecycle({ kind: 'team_purge', commandId: effect.commandId, transactionId, phase: 'deleted', principalId: 'forged' }, lookup.operation, effect.commandId)).toThrow();
});


it('a fresh renderer explicitly resumes only the trusted prepared purge command/CAS and resolves lost ACK by its original lookup', async () => {
  const pendingPurge = { commandId: 'TEST-before-restart', expectedRevision: revision };
  const transactionId = '70b7498f-f097-428c-ad20-b8d8d6a93510';
  const f = fixture(async request => {
    if (request.operation === 'team.lifecycle.read') return { ok: true, value: projectTeamLifecycle({
      kind: 'team_lifecycle', revision: next, deletedAt: '2026-10-23T00:00:00.000Z', cleanupPending: false, pendingPurge,
    }, request.operation, request.commandId)! };
    if (request.operation === 'team.lifecycle.purge') throw new Error('TEST-completed-original-ACK-lost');
    return { ok: true, value: { kind: 'team_purge', commandId: request.commandId, transactionId, phase: 'deleted' } };
  });
  expect(f.invoke).not.toHaveBeenCalled();
  await f.api.permanentlyDeleteTeam('TEST-original-key');
  expect(f.invoke.mock.calls.map(([request]) => request.operation)).toEqual(['team.lifecycle.read', 'team.lifecycle.purge', 'team.lifecycle.purge.lookup']);
  const effect = f.invoke.mock.calls[1]![0], lookup = f.invoke.mock.calls[2]![0];
  expect(effect.commandId).toBe(pendingPurge.commandId);
  expect(effect.payload).toEqual({ expectedRevision: revision });
  expect(lookup).toEqual({ handle: effect.handle, commandId: pendingPurge.commandId, operation: 'team.lifecycle.purge.lookup', payload: { expected: { expectedRevision: revision } } });
});

it('prepared purge hints cannot leak private intent fields or bypass the captured renderer context', async () => {
  const view = { kind: 'team_lifecycle', revision, deletedAt: '2026-10-23T00:00:00.000Z', cleanupPending: false };
  expect(() => projectTeamLifecycle({ ...view, pendingPurge: { commandId: 'TEST-original', expectedRevision: revision, principalId: 'TEST-private' } }, 'team.lifecycle.read', 'TEST-read')).toThrow();
  expect(() => projectTeamLifecycle({ ...view, pendingPurge: { commandId: 'TEST-original', expectedRevision: 'TEST-invalid' } }, 'team.lifecycle.read', 'TEST-read')).toThrow();
  const f = fixture(async () => {
    f.invalidate();
    return { ok: true, value: { ...view, kind: 'team_lifecycle', pendingPurge: { commandId: 'TEST-original', expectedRevision: revision } } };
  });
  await expect(f.api.permanentlyDeleteTeam('TEST-original-key')).rejects.toMatchObject({ code: 'context-changed', outcome: 'not-dispatched' });
  expect(f.invoke.mock.calls.map(([request]) => request.operation)).toEqual(['team.lifecycle.read']);
});
