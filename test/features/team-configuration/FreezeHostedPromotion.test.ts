import { FreezeHostedPromotion } from '@features/team-configuration/core/application/hosted-authority/FreezeHostedPromotion';
import { describe, expect, it, vi } from 'vitest';

import type { HostedPromotionBegin, HostedPromotionRecord } from '@features/internal-storage/contracts';

const request = { workspaceId: 'workspace_public', teamId: 'team_original', expectedRevision: 'revision_saved',
  idempotencyKey: 'idempotency_original' } as HostedPromotionBegin;
const binding = { actorId: 'actor_original', deploymentId: 'deployment_original', runtimeWorkspaceId: 'workspace_runtime',
  bindingGeneration: 1, createOperationId: 'adoption_original', admittedWorkspaceRoot: '/sandbox/project' } as HostedPromotionBegin;
const operation = { ...request, ...binding, operationId: 'promotion_original', state: 'frozen',
  planJson: 'private', frozenDraftJson: 'private', laneIds: ['private'], planGeneration: 'private' } as unknown as HostedPromotionRecord;

describe('promotion source prerequisite application seam', () => {
  it('captures and revalidates host authority and exposes only bounded pending status', async () => {
    const calls: string[] = [];
    const begin = vi.fn(async () => { calls.push('freeze'); return { kind: 'frozen' as const, operation }; });
    const useCase = new FreezeHostedPromotion({ storage: { begin, lookup: async () => operation },
      capture: async () => { calls.push('capture'); return { binding, revalidate: async () => { calls.push('fence'); } }; } });
    const status = await useCase.execute(request, { signal: new AbortController().signal, deadlineAtMs: 100 });
    expect(calls).toEqual(['capture', 'fence', 'freeze', 'fence']);
    expect(status).toEqual({ operationId: 'promotion_original', teamId: 'team_original', revision: 'revision_saved', state: 'frozen_awaiting_owner_adapter' });
    expect(begin.mock.calls).toHaveLength(1);
    expect(useCase).not.toHaveProperty('launch');
    expect(useCase).not.toHaveProperty('unfreeze');
  });
  it('does not call storage when capture/fence fails', async () => {
    const begin = vi.fn();
    const useCase = new FreezeHostedPromotion({ storage: { begin, lookup: async () => null },
      capture: async () => ({ binding, revalidate: async () => { throw new Error('revoked'); } }) });
    await expect(useCase.execute(request, { signal: new AbortController().signal, deadlineAtMs: 100 })).rejects.toThrow('revoked');
    expect(begin).not.toHaveBeenCalled();
  });
  it('retains the operation after a lost post-commit fence and permits exact status recovery', async () => {
    let committed = false;
    const useCase = new FreezeHostedPromotion({ storage: {
      begin: async () => { committed = true; return { kind: 'frozen', operation }; }, lookup: async () => operation },
    capture: async () => ({ binding, revalidate: async () => { if (committed) throw new Error('revoked-after-commit'); } }) });
    await expect(useCase.execute(request, { signal: new AbortController().signal, deadlineAtMs: 100 })).rejects.toThrow('revoked-after-commit');
    expect(await useCase.status({ ...request, ...binding, reference: { operationId: operation.operationId } })).toMatchObject({ state: 'frozen_awaiting_owner_adapter' });
  });
});
