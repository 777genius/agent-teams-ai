import { ManagementError } from '@uap/management-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ExtensionRuntimeGate } from '../../../src/features/extension-management/core/application/ExtensionRuntimeGate';
import { createExtensionManagementFeature } from '../../../src/features/extension-management/main/composition/createExtensionManagementFeature';

import type {
  ManagementChange,
  ManagementClient,
  ManagementOperation,
  ManagementSession,
} from '../../../src/features/extension-management/contracts';

const session: ManagementSession = {
  apiVersion: 1,
  engineVersion: 'test',
  contextId: 'engine-a',
  environmentId: 'environment-a',
  scope: 'user',
  targets: [],
  capabilities: [],
};
function operation(state: ManagementOperation['state'] = 'queued'): ManagementOperation {
  return {
    operationId: 'op-a',
    requestId: 'request-identity-a',
    planId: 'plan-a',
    contextId: 'engine-a',
    environmentId: 'environment-a',
    action: 'sync',
    state,
    phase: 'prepare',
    completed: 0,
    total: 1,
    items: [],
    diagnostics: [],
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
  };
}
function fixture(pending: ManagementOperation[] = []) {
  const gate = new ExtensionRuntimeGate();
  let captureVersion = 0;
  const client = {
    session: vi.fn(async () => session),
    environment: vi.fn(async () => ({
      contextId: 'engine-a',
      entries: [],
      diagnostics: [],
      pendingOperations: pending,
    })),
    catalog: vi.fn(async () => ({ items: [], freshness: 'current', diagnostics: [] })),
    catalogEntry: vi.fn(async () => ({
      id: 'reviewed-plugin',
      source: 'reviewed-plugin',
      available: true,
    })),
    prepare: vi.fn(async (change: ManagementChange) => ({
      planId: 'plan-a',
      contextId: 'engine-a',
      action: change.action,
      expiresAt: '2099-01-01T00:00:00Z',
      confirmable: true,
      actions: [],
      warnings: [],
      conflicts: [],
    })),
    apply: vi.fn(async () => operation()),
    operation: vi.fn(async () => operation()),
    wait: vi.fn(() => new Promise(() => {})),
    cancel: vi.fn(async () => operation('cancelled')),
    plans: { discard: vi.fn(async () => {}) },
  };
  const assertCurrent = vi.fn(async () => {}),
    assertInactive = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const feature = createExtensionManagementFeature(
    {
      capture: async (selection) => ({
        identity: `profile-${selection.client}-${captureVersion}`,
        label: selection.client,
        selection,
        resources: ['profile-root', 'other-profile'],
        resourcesForPlan: () => ['profile-root'],
        assertCurrent,
        assertInactive,
        connect: async () => ({ client: client as unknown as ManagementClient, session, close }),
      }),
    },
    gate
  );
  return {
    feature,
    client,
    gate,
    assertCurrent,
    assertInactive,
    close,
    advanceCapture: () => {
      captureVersion += 1;
    },
  };
}
describe('captured extension management', () => {
  it('resolves a catalog identity in the trusted host and preserves signed source identity', async () => {
    const f = fixture(),
      context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({
      contextId: context.contextId,
      change: { action: 'install' },
      catalogEntryId: 'reviewed-plugin',
    });
    expect(f.client.prepare).toHaveBeenCalledWith({ action: 'install', source: 'reviewed-plugin' });
    await f.feature.close();
  });
  it('rejects changed authority before asking the engine to prepare or apply', async () => {
    const f = fixture(),
      context = await f.feature.capture({ client: 'claude', scope: 'user' });
    f.assertCurrent.mockRejectedValue(new Error('stale profile'));
    await expect(
      f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } })
    ).rejects.toThrow('stale profile');
    expect(f.client.prepare).not.toHaveBeenCalled();
    await f.feature.close();
  });
  it('observes repeated accepted requests without another mutation and rejects conflicting IDs', async () => {
    const f = fixture(),
      context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
    const input = {
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'request-identity-a',
    };
    await f.feature.apply(input);
    await f.feature.apply(input);
    expect(f.client.apply).toHaveBeenCalledTimes(1);
    expect(f.client.operation).toHaveBeenCalledWith('op-a');
    await expect(f.feature.apply({ ...input, planId: 'another-plan' })).rejects.toThrow(
      'another prepared change'
    );
    await f.feature.close();
  });
  it('restores the runtime fence from interrupted durable operations on a new host session', async () => {
    const f = fixture([operation('interrupted')]);
    await f.feature.capture({ client: 'claude', scope: 'user' });
    await expect(f.gate.launch(['profile-root'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    await f.feature.close();
  });
  it('does not release outstanding work when an older successful operation is inspected', async () => {
    const f = fixture([operation('interrupted')]);
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    f.client.operation.mockResolvedValue({
      ...operation('succeeded'),
      operationId: 'old-operation',
    });
    await f.feature.operation({ contextId: context.contextId, operationId: 'old-operation' });
    await expect(f.gate.launch(['profile-root'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    await f.feature.close();
  });
  it('retains admission while apply acceptance races with an environment refresh', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
    let accept!: (value: ManagementOperation) => void;
    f.client.apply.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        })
    );
    const application = f.feature.apply({
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'request-identity-a',
    });
    await vi.waitFor(() => expect(f.client.apply).toHaveBeenCalledOnce());
    await f.feature.environment({ contextId: context.contextId });
    await expect(f.gate.launch(['profile-root'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    accept(operation());
    await application;
    await f.feature.close();
  });
  it('closes the owned engine when initial durable inspection fails', async () => {
    const f = fixture();
    f.client.environment.mockRejectedValue(new Error('inspection unavailable'));
    await expect(f.feature.capture({ client: 'claude', scope: 'user' })).rejects.toThrow(
      'inspection unavailable'
    );
    expect(f.close).toHaveBeenCalledOnce();
  });
  it('retains uncertain acceptance through empty inspection and retries the same identity', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
    const request = {
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'request-identity-a',
    };
    f.client.apply.mockRejectedValueOnce(new Error('lost response'));
    await expect(f.feature.apply(request)).rejects.toThrow('lost response');
    const environment = await f.feature.environment({ contextId: context.contextId });
    expect(environment.uncertainApplications).toEqual([
      {
        plan: expect.objectContaining({ planId: 'plan-a' }),
        requestId: 'request-identity-a',
        contextId: context.contextId,
      },
    ]);
    await expect(
      f.feature.discardPlan({ contextId: context.contextId, planId: 'plan-a' })
    ).rejects.toThrow('Confirm the result');
    await expect(f.gate.launch(['profile-root'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    await f.feature.apply(request);
    expect(f.client.apply).toHaveBeenNthCalledWith(2, 'plan-a', 'request-identity-a');
    await f.feature.close();
  });
  it('refuses arbitrary local paths from the renderer', async () => {
    const f = fixture(),
      context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await expect(
      f.feature.prepare({
        contextId: context.contextId,
        change: { action: 'install', source: '/private/source' },
      })
    ).rejects.toThrow();
    expect(f.client.prepare).not.toHaveBeenCalled();
    await f.feature.close();
  });
  it('clears uncertainty only after a definitive pre-effect refusal and fresh inspection', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
    const request = {
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'request-identity-a',
    };
    f.client.apply.mockRejectedValueOnce(new Error('lost response'));
    await expect(f.feature.apply(request)).rejects.toThrow('lost response');
    f.client.apply.mockRejectedValueOnce(new ManagementError('PLAN_STALE', 'Review expired', 409));
    await expect(f.feature.apply(request)).rejects.toThrow('Review expired');
    expect(
      (await f.feature.environment({ contextId: context.contextId })).uncertainApplications
    ).toEqual([]);
    await expect(f.gate.launch(['profile-root'], async () => 'started')).resolves.toBe('started');
    await f.feature.close();
  });
  it('keeps recovery reachable after a changed capture of the same durable environment', async () => {
    const f = fixture([operation('interrupted')]);
    const first = await f.feature.capture({ client: 'claude', scope: 'user' });
    f.advanceCapture();
    const second = await f.feature.capture({ client: 'claude', scope: 'user' });
    expect(second.contextId).not.toBe(first.contextId);
    await f.feature.prepare({
      contextId: second.contextId,
      change: { action: 'recover', operationId: 'op-a' },
    });
    f.client.apply.mockResolvedValue({
      ...operation('succeeded'),
      requestId: 'recovery-identity-b',
    });
    f.client.environment.mockResolvedValue({
      contextId: 'engine-a',
      entries: [],
      diagnostics: [],
      pendingOperations: [],
    });
    await f.feature.apply({
      contextId: second.contextId,
      planId: 'plan-a',
      requestId: 'recovery-identity-b',
    });
    await expect(f.gate.launch(['profile-root'], async () => 'started')).resolves.toBe('started');
    await f.feature.close();
  });
  it('widens a targeted fence when fresh durable inspection reveals broader pending work', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
    await f.feature.apply({
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'request-identity-a',
    });
    await expect(f.gate.launch(['other-profile'], async () => 'started')).resolves.toBe('started');
    f.client.environment.mockResolvedValue({
      contextId: 'engine-a',
      entries: [],
      diagnostics: [],
      pendingOperations: [operation('interrupted')],
    });
    await f.feature.environment({ contextId: context.contextId });
    await expect(f.gate.launch(['other-profile'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    await f.feature.close();
  });
});
