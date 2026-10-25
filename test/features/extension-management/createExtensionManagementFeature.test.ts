import { ManagementError } from '@uap/management-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ExtensionRuntimeGate } from '../../../src/features/extension-management/core/application/ExtensionRuntimeGate';
import { createExtensionManagementFeature } from '../../../src/features/extension-management/main/composition/createExtensionManagementFeature';

import type {
  LocalSkillChange,
  ManagementChange,
  ManagementClient,
  ManagementOperation,
  ManagementPlan,
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
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
    discoverSkills: vi.fn(),
    prepare: vi.fn(
      async (change: ManagementChange): Promise<ManagementPlan> => ({
        planId: 'plan-a',
        contextId: 'engine-a',
        action: change.action,
        expiresAt: '2099-01-01T00:00:00Z',
        confirmable: true,
        actions: [],
        warnings: [],
        conflicts: [],
      })
    ),
    apply: vi.fn<(planId: string, requestId: string) => Promise<ManagementOperation>>(async () =>
      operation()
    ),
    operation: vi.fn(async () => operation()),
    wait: vi.fn(() => new Promise(() => {})),
    cancel: vi.fn(async () => operation('canceled')),
    plans: { discard: vi.fn(async () => {}) },
    skills: {
      discard: vi.fn(async () => {}),
      local: {
        prepare: vi.fn(async (change: LocalSkillChange) => ({
          planId: `plan-${change.action}`,
          contextId: 'engine-a',
          action: 'local_skill',
          expiresAt: '2099-01-01T00:00:00Z',
          confirmable: true,
          actions: [],
          warnings: [],
          conflicts: [],
        })),
      },
    },
  };
  const assertCurrent = vi.fn(async () => {}),
    assertInactive = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const resourcesForPlan = vi.fn((_plan: ManagementPlan) => ['profile-root']);
  const feature = createExtensionManagementFeature(
    {
      capture: async (selection) => ({
        identity: `profile-${selection.client}-${captureVersion}`,
        label: selection.client,
        selection,
        resources: ['profile-root', 'other-profile'],
        resourcesForPlan,
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
    resourcesForPlan,
    advanceCapture: () => {
      captureVersion += 1;
    },
  };
}
describe('captured extension management', () => {
  it.each([
    'owner/repository@feature/plugins',
    'owner/repository@v1.2.3',
    `owner/repository@${'a'.repeat(40)}`,
    'git+https://example.com/owner/repository.git#main',
    'ssh://git@example.com/owner/repository.git#main',
    'https://example.com/plugin.tar.gz',
  ])('passes the plugin source reference %s through the real input boundary', async (source) => {
    const f = fixture();
    try {
      const context = await f.feature.capture({ client: 'claude', scope: 'user' });
      await f.feature.prepare({
        contextId: context.contextId,
        change: { action: 'install', source: ` ${source} ` },
      });
      expect(f.client.prepare).toHaveBeenCalledExactlyOnceWith({ action: 'install', source });
    } finally {
      await f.feature.close();
    }
  });
  it('rejects empty, oversized and control-containing plugin sources before invoking the engine', async () => {
    const f = fixture();
    try {
      const context = await f.feature.capture({ client: 'claude', scope: 'user' });
      for (const source of [
        '',
        '   ',
        'a'.repeat(2049),
        'owner/repository@one\ntwo',
        'bad\u0000source',
      ]) {
        await expect(
          f.feature.prepare({ contextId: context.contextId, change: { action: 'install', source } })
        ).rejects.toThrow();
      }
      expect(f.client.prepare).not.toHaveBeenCalled();
    } finally {
      await f.feature.close();
    }
  });
  it('keeps Skill discovery restricted to HTTP(S) sources without credentials', async () => {
    const f = fixture();
    try {
      const context = await f.feature.capture({ client: 'claude', scope: 'user' });
      for (const source of [
        'owner/repository@main',
        'ssh://git@example.com/owner/repository.git',
        'https://user:secret@example.com/owner/repository',
      ]) {
        await expect(
          f.feature.discoverSkills({ contextId: context.contextId, source: { source } })
        ).rejects.toThrow();
      }
      expect(f.client.discoverSkills).not.toHaveBeenCalled();
    } finally {
      await f.feature.close();
    }
  });
  it('extends an existing targeted lease before awaiting a broader recovery activity check', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
    await f.feature.apply({
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'request-identity-a',
    });
    await f.feature.prepare({
      contextId: context.contextId,
      change: { action: 'recover', operationId: 'op-a' },
    });
    f.resourcesForPlan.mockReturnValue(['profile-root', 'other-profile']);
    let resume!: () => void;
    let checking!: () => void;
    const check = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      checking = resolve;
    });
    f.assertInactive.mockImplementationOnce(async () => {
      checking();
      await check;
    });
    f.client.apply.mockResolvedValueOnce({
      ...operation('succeeded'),
      requestId: 'recovery-request-a',
    });
    const recovery = f.feature.apply({
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'recovery-request-a',
    });
    await started;
    await expect(f.gate.launch(['other-profile'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    resume();
    await recovery;
    await f.feature.close();
  });
  it('releases a discovery through its captured SDK client without discarding a retained review', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
    await f.feature.discardSkillCatalog({ contextId: context.contextId, catalogId: 'catalog-a' });
    expect(f.client.skills.discard).toHaveBeenCalledWith('catalog-a');
    expect(f.client.plans.discard).not.toHaveBeenCalled();
    await f.feature.apply({
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'catalog-independent-review',
    });
    expect(f.client.apply).toHaveBeenCalledOnce();
    await f.feature.close();
  });
  it('passes explicit native-removal attestation to the engine for the reviewed graph intent', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    const change: ManagementChange = {
      action: 'update',
      aliases: ['root-a'],
      externalUninstalled: true,
    };
    await f.feature.prepare({ contextId: context.contextId, change });
    expect(f.client.prepare).toHaveBeenCalledWith(change);
    await f.feature.close();
  });
  it('admits exact local restoration through a pending fence while refusing new local work', async () => {
    const pending: ManagementOperation = {
      ...operation('partial'),
      action: 'local_skill',
      localSkill: { rootId: 'root-a', skillName: 'demo' },
    };
    const f = fixture([pending]);
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepareLocalSkill({
      contextId: context.contextId,
      change: { action: 'upsert', rootId: 'root-a', skillName: 'demo', files: [] },
    });
    await expect(
      f.feature.apply({
        contextId: context.contextId,
        planId: 'plan-upsert',
        requestId: 'local-upsert-request',
      })
    ).rejects.toThrow('outstanding extension operation');
    await f.feature.prepareLocalSkill({
      contextId: context.contextId,
      change: {
        action: 'restore',
        rootId: 'root-a',
        skillName: 'demo',
        restoreOperationId: pending.operationId,
      },
    });
    await f.feature.apply({
      contextId: context.contextId,
      planId: 'plan-restore',
      requestId: 'local-restore-request',
    });
    expect(f.client.skills.local.prepare).toHaveBeenLastCalledWith({
      action: 'restore',
      rootId: 'root-a',
      skillName: 'demo',
      restoreOperationId: pending.operationId,
    });
    expect(f.client.apply).toHaveBeenCalledTimes(1);
    await f.feature.close();
  });
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
  it('rejects an old empty inspection after a later acceptance in another capture of the same environment', async () => {
    const f = fixture();
    const first = await f.feature.capture({ client: 'claude', scope: 'user' });
    f.advanceCapture();
    const second = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: second.contextId, change: { action: 'sync' } });
    const empty = await f.client.environment();
    let finishInspection!: () => void;
    f.client.environment.mockReturnValueOnce(
      new Promise((resolve) => {
        finishInspection = () => resolve(empty);
      })
    );
    const inspection = f.feature.environment({ contextId: first.contextId });
    const rejection = expect(inspection).rejects.toThrow('changed during inspection');
    await f.feature.apply({
      contextId: second.contextId,
      planId: 'plan-a',
      requestId: 'request-identity-a',
    });
    finishInspection();
    await rejection;
    await expect(f.gate.launch(['profile-root'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    await f.feature.close();
  });
  it('keeps an existing recovery fence while asynchronous activity admission is checked', async () => {
    const f = fixture([operation('interrupted')]);
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({
      contextId: context.contextId,
      change: { action: 'recover', operationId: 'op-a' },
    });
    let admit!: () => void;
    f.assertInactive.mockClear().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          admit = resolve;
        })
    );
    const application = f.feature.apply({
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'recovery-request',
    });
    await vi.waitFor(() => expect(f.assertInactive).toHaveBeenCalledOnce());
    f.client.environment.mockResolvedValue({
      contextId: 'engine-a',
      entries: [],
      diagnostics: [],
      pendingOperations: [],
    });
    await f.feature.environment({ contextId: context.contextId });
    await expect(f.gate.launch(['profile-root'], async () => 'started')).rejects.toThrow(
      'extension change'
    );
    admit();
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
    for (const source of [
      '/private/source',
      './source',
      '../source',
      'C:\\source',
      'file:///source',
    ]) {
      await expect(
        f.feature.prepare({
          contextId: context.contextId,
          change: { action: 'install', source },
        })
      ).rejects.toThrow();
    }
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
  it('does not lose a lease when different provider applies overlap in one environment', async () => {
    const f = fixture();
    const first = await f.feature.capture({ client: 'claude', scope: 'user' });
    const second = await f.feature.capture({ client: 'opencode', scope: 'user' });
    const plan = await f.feature.prepare({
      contextId: first.contextId,
      change: { action: 'sync' },
    });
    f.client.prepare.mockResolvedValueOnce({ ...plan, planId: 'plan-b' });
    await f.feature.prepare({ contextId: second.contextId, change: { action: 'sync' } });
    f.resourcesForPlan.mockImplementation((review) =>
      review.planId === 'plan-a' ? ['profile-root'] : ['other-profile']
    );
    f.client.apply.mockImplementation((planId, requestId) =>
      Promise.resolve({ ...operation('succeeded'), operationId: `op-${planId}`, planId, requestId })
    );
    const activity = deferred<void>(),
      started = deferred<void>();
    f.assertInactive.mockImplementationOnce(() => {
      started.resolve();
      return activity.promise;
    });
    const applying = f.feature.apply({
      contextId: first.contextId,
      planId: 'plan-a',
      requestId: 'first-request-identity',
    });
    const request = {
      contextId: second.contextId,
      planId: 'plan-b',
      requestId: 'second-request-identity',
    };
    try {
      await started.promise;
      const refusal = await f.feature.apply(request).then(
        () => undefined,
        (error: unknown) => error
      );
      activity.resolve();
      await applying;
      await f.feature.environment({ contextId: first.contextId });
      await expect(
        f.gate.launch(['profile-root', 'other-profile'], () => Promise.resolve('started'))
      ).resolves.toBe('started');
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain('outstanding extension operation');
      await f.feature.apply(request);
      expect(f.client.apply).toHaveBeenCalledTimes(2);
      await expect(
        f.gate.launch(['profile-root', 'other-profile'], () => Promise.resolve('started'))
      ).resolves.toBe('started');
    } finally {
      activity.resolve();
      await applying.catch(() => null);
      await f.feature.close();
    }
  });
  it('releases a refused initial reservation after fresh empty inspection', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
    f.assertInactive.mockRejectedValueOnce(new Error('profile became active'));
    await expect(
      f.feature.apply({
        contextId: context.contextId,
        planId: 'plan-a',
        requestId: 'refused-request-identity',
      })
    ).rejects.toThrow('profile became active');
    expect(f.client.apply).not.toHaveBeenCalled();
    await expect(f.gate.launch(['profile-root'], () => Promise.resolve('started'))).resolves.toBe(
      'started'
    );
    await f.feature.close();
  });
  it('shares an initial reservation with durable reconciliation before an activity refusal', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
    const activity = deferred<void>(),
      started = deferred<void>();
    f.assertInactive.mockImplementationOnce(() => {
      started.resolve();
      return activity.promise;
    });
    const applying = f.feature.apply({
      contextId: context.contextId,
      planId: 'plan-a',
      requestId: 'refused-request-identity',
    });
    const refusal = expect(applying).rejects.toThrow('profile became active');
    try {
      await started.promise;
      f.client.environment.mockResolvedValue({
        contextId: 'engine-a',
        entries: [],
        diagnostics: [],
        pendingOperations: [operation('interrupted')],
      });
      await f.feature.environment({ contextId: context.contextId });
      activity.reject(new Error('profile became active'));
      await refusal;
      expect(f.client.apply).not.toHaveBeenCalled();
      await expect(
        f.gate.launch(['other-profile'], () => Promise.resolve('started'))
      ).rejects.toThrow('extension change');
      f.client.environment.mockResolvedValue({
        contextId: 'engine-a',
        entries: [],
        diagnostics: [],
        pendingOperations: [],
      });
      await f.feature.environment({ contextId: context.contextId });
      await expect(
        f.gate.launch(['profile-root', 'other-profile'], () => Promise.resolve('started'))
      ).resolves.toBe('started');
    } finally {
      activity.reject(new Error('profile became active'));
      await refusal;
      await f.feature.close();
    }
  });
  it.each(['authority', 'activity'] as const)(
    'closes without a late mutation while %s validation is pending',
    async (phase) => {
      const f = fixture();
      const context = await f.feature.capture({ client: 'claude', scope: 'user' });
      await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
      const validation = deferred<void>(),
        started = deferred<void>();
      (phase === 'authority' ? f.assertCurrent : f.assertInactive).mockImplementationOnce(() => {
        started.resolve();
        return validation.promise;
      });
      const applying = f.feature.apply({
        contextId: context.contextId,
        planId: 'plan-a',
        requestId: 'closing-request-identity',
      });
      const outcome = applying.then(
        () => undefined,
        (error: unknown) => error
      );
      try {
        await started.promise;
        await f.feature.close();
        await expect(
          f.gate.launch(['profile-root'], () => Promise.resolve('started'))
        ).resolves.toBe('started');
        validation.resolve();
        const refusal = await outcome;
        expect(refusal).toBeInstanceOf(Error);
        expect((refusal as Error).message).toContain('closing');
        expect(f.client.apply).not.toHaveBeenCalled();
        await expect(
          f.gate.launch(['profile-root'], () => Promise.resolve('started'))
        ).resolves.toBe('started');
      } finally {
        validation.resolve();
        await outcome;
        await f.feature.close();
      }
    }
  );
  it('does not recreate a fence when durable inspection returns after close', async () => {
    const f = fixture();
    const context = await f.feature.capture({ client: 'claude', scope: 'user' });
    const inspection = deferred<Awaited<ReturnType<typeof f.client.environment>>>(),
      started = deferred<void>();
    f.client.environment.mockImplementationOnce(() => {
      started.resolve();
      return inspection.promise;
    });
    const pending = f.feature.environment({ contextId: context.contextId });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error
    );
    await started.promise;
    await f.feature.close();
    inspection.resolve({
      contextId: 'engine-a',
      entries: [],
      diagnostics: [],
      pendingOperations: [operation('interrupted')],
    });
    expect(await outcome).toBeInstanceOf(Error);
    await expect(
      f.gate.launch(['profile-root', 'other-profile'], () => Promise.resolve('started'))
    ).resolves.toBe('started');
  });
});
