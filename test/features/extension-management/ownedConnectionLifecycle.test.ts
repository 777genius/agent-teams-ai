// @vitest-environment node
import { ManagementError } from '@uap/management-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ExtensionRuntimeGate } from '../../../src/features/extension-management/core/application/ExtensionRuntimeGate';
import { createExtensionManagementFeature } from '../../../src/features/extension-management/main/composition/createExtensionManagementFeature';

import type {
  ManagementClient,
  ManagementEnvironment,
  ManagementOperation,
  ManagementPlan,
  ManagementSession,
} from '../../../src/features/extension-management/contracts';
import type { CapturedExtensionEnvironment } from '../../../src/features/extension-management/core/application/ports';

const selection = { client: 'claude', scope: 'user' } as const;
const session: ManagementSession = {
  apiVersion: 1,
  engineVersion: 'test',
  contextId: 'engine-a',
  environmentId: 'environment-a',
  scope: 'user',
  targets: [],
  capabilities: [],
};
const plan: ManagementPlan = {
  planId: 'original-plan',
  contextId: session.contextId,
  action: 'sync',
  expiresAt: '2099-01-01T00:00:00Z',
  confirmable: true,
  actions: [],
  warnings: [],
  conflicts: [],
};
function operation(state: ManagementOperation['state'] = 'queued'): ManagementOperation {
  return {
    operationId: 'original-operation',
    requestId: 'original-request',
    planId: plan.planId,
    contextId: session.contextId,
    environmentId: session.environmentId,
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
function environment(pendingOperations: ManagementOperation[] = []): ManagementEnvironment {
  return { contextId: session.contextId, entries: [], diagnostics: [], pendingOperations };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
function ownedConnection(pending: ManagementOperation[] = []) {
  let exited = false;
  const client = {
    environment: vi.fn(async () => environment(pending)),
    prepare: vi.fn(async () => plan),
    apply: vi.fn(async (_planId: string, _requestId: string) => operation()),
    operation: vi.fn(async () => operation()),
    wait: vi.fn(() => new Promise<ManagementOperation>(() => {})),
    plans: { discard: vi.fn(async (_planId: string) => {}) },
  };
  const connection: Awaited<ReturnType<CapturedExtensionEnvironment['connect']>> = {
    client: client as unknown as ManagementClient,
    session,
    get hasExited() {
      return exited;
    },
    close: vi.fn(async () => {}),
  };
  return { client, connection, exit: () => (exited = true) };
}
function fixture(...hosts: ReturnType<typeof ownedConnection>[]) {
  const gate = new ExtensionRuntimeGate();
  let index = 0;
  const connect = vi.fn(async () => hosts[index++].connection);
  const feature = createExtensionManagementFeature(
    {
      capture: async (selected) => ({
        identity: `captured-${selected.client}`,
        label: selected.client,
        selection: selected,
        resources: ['captured-profile'],
        assertCurrent: async () => {},
        assertInactive: async () => {},
        connect,
      }),
    },
    gate
  );
  return { feature, gate, connect };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('owned extension connection lifecycle', () => {
  it('reconnects once, retains the public identity and inspects before opening launch admission', async () => {
    const first = ownedConnection(),
      replacement = ownedConnection(),
      inspection = deferred<ManagementEnvironment>();
    replacement.client.environment.mockReturnValueOnce(inspection.promise);
    const f = fixture(first, replacement);
    try {
      const context = await f.feature.capture(selection);
      first.exit();
      const recapture = f.feature.capture(selection);
      await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(2));
      const refresh = f.feature.environment({ contextId: context.contextId });
      await expect(f.gate.launch(['captured-profile'], async () => {})).rejects.toThrow('recovery');
      inspection.resolve(environment());
      expect(await recapture).toEqual(context);
      await refresh;
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(first.connection.close).toHaveBeenCalledTimes(1);
      await expect(f.gate.launch(['captured-profile'], async () => 'ready')).resolves.toBe('ready');
    } finally {
      inspection.resolve(environment());
      await f.feature.close();
    }
    expect(replacement.connection.close).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed replacement inspection fenced and retries it without restarting the live child', async () => {
    const first = ownedConnection(),
      replacement = ownedConnection();
    replacement.client.environment.mockRejectedValueOnce(new Error('ledger unreadable'));
    const f = fixture(first, replacement);
    try {
      const context = await f.feature.capture(selection);
      first.exit();
      await expect(f.feature.capture(selection)).rejects.toThrow('ledger unreadable');
      await expect(f.gate.launch(['captured-profile'], async () => {})).rejects.toThrow('recovery');
      expect(await f.feature.capture(selection)).toEqual(context);
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(replacement.connection.close).not.toHaveBeenCalled();
      await expect(f.gate.launch(['captured-profile'], async () => 'ready')).resolves.toBe('ready');
    } finally {
      await f.feature.close();
    }
  });

  it('does not restart or close a live child after an ordinary transport failure', async () => {
    const host = ownedConnection();
    const f = fixture(host);
    try {
      const context = await f.feature.capture(selection);
      host.client.environment.mockRejectedValueOnce(new Error('transport unavailable'));
      await expect(f.feature.environment({ contextId: context.contextId })).rejects.toThrow(
        'transport unavailable'
      );
      expect(await f.feature.capture(selection)).toEqual(context);
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(host.connection.close).not.toHaveBeenCalled();
    } finally {
      await f.feature.close();
    }
  });

  it.each([
    { environmentId: 'different-environment' },
    { contextId: 'different-context' },
    { scope: 'project' as const },
    {
      targets: [
        {
          id: 'unexpected-target',
          client: 'claude',
          label: 'Unexpected profile',
          scope: 'user' as const,
          displayPath: '/different-profile',
          available: true,
        },
      ],
    },
  ])('refuses replacement authority drift without dropping the fence: %j', async (drift) => {
    const first = ownedConnection(),
      replacement = ownedConnection();
    replacement.connection.session = { ...session, ...drift };
    const f = fixture(first, replacement);
    try {
      await f.feature.capture(selection);
      first.exit();
      await expect(f.feature.capture(selection)).rejects.toThrow(/changed|match/i);
      expect(replacement.connection.close).toHaveBeenCalledTimes(1);
      expect(replacement.client.environment).not.toHaveBeenCalled();
      await expect(f.gate.launch(['captured-profile'], async () => {})).rejects.toThrow('recovery');
    } finally {
      await f.feature.close();
    }
  });

  it('rejects an old empty inspection after the replacement restored durable pending work', async () => {
    const first = ownedConnection(),
      replacement = ownedConnection([operation('interrupted')]),
      oldInspection = deferred<ManagementEnvironment>();
    const f = fixture(first, replacement);
    try {
      const context = await f.feature.capture(selection);
      first.client.environment.mockReturnValueOnce(oldInspection.promise);
      const oldRead = f.feature.environment({ contextId: context.contextId });
      const oldRefusal = expect(oldRead).rejects.toThrow(/expired|changed/i);
      await vi.waitFor(() => expect(first.client.environment).toHaveBeenCalledTimes(2));
      first.exit();
      await f.feature.capture(selection);
      oldInspection.resolve(environment());
      await oldRefusal;
      await expect(f.gate.launch(['captured-profile'], async () => {})).rejects.toThrow('recovery');
    } finally {
      oldInspection.resolve(environment());
      await f.feature.close();
    }
  });

  it('expires a late old prepared review and only discards it through its original connection', async () => {
    const first = ownedConnection(),
      replacement = ownedConnection(),
      preparation = deferred<ManagementPlan>();
    const f = fixture(first, replacement);
    try {
      const context = await f.feature.capture(selection);
      first.client.prepare.mockReturnValueOnce(preparation.promise);
      const review = f.feature.prepare({
        contextId: context.contextId,
        change: { action: 'sync' },
      });
      const oldRefusal = expect(review).rejects.toThrow(/expired|changed/i);
      await vi.waitFor(() => expect(first.client.prepare).toHaveBeenCalledTimes(1));
      first.exit();
      await f.feature.capture(selection);
      preparation.resolve(plan);
      await oldRefusal;
      expect(first.client.plans.discard).toHaveBeenCalledExactlyOnceWith(plan.planId);
      expect(replacement.client.plans.discard).not.toHaveBeenCalled();
    } finally {
      preparation.resolve(plan);
      await f.feature.close();
    }
  });

  it('keeps uncertain request identity across exit and reconciles an exact PLAN_STALE replay', async () => {
    const first = ownedConnection(),
      replacement = ownedConnection();
    const f = fixture(first, replacement);
    try {
      const context = await f.feature.capture(selection);
      await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
      const request = {
        contextId: context.contextId,
        planId: plan.planId,
        requestId: 'original-request',
      };
      first.client.apply.mockRejectedValueOnce(new Error('acceptance reply lost'));
      await expect(f.feature.apply(request)).rejects.toThrow('acceptance reply lost');
      first.exit();
      expect(await f.feature.capture(selection)).toEqual(context);
      const observed = await f.feature.environment({ contextId: context.contextId });
      expect(observed.uncertainApplications).toEqual([
        { contextId: request.contextId, requestId: request.requestId, plan },
      ]);
      await expect(
        f.feature.discardPlan({ contextId: request.contextId, planId: request.planId })
      ).rejects.toThrow('same request identity');
      replacement.client.apply.mockRejectedValueOnce(
        new ManagementError('PLAN_STALE', 'Review expired', 409)
      );
      await expect(f.feature.apply(request)).rejects.toThrow('Review expired');
      expect(replacement.client.apply).toHaveBeenCalledExactlyOnceWith(
        plan.planId,
        request.requestId
      );
      expect(
        (await f.feature.environment({ contextId: context.contextId })).uncertainApplications
      ).toEqual([]);
      await expect(f.gate.launch(['captured-profile'], async () => 'ready')).resolves.toBe('ready');
    } finally {
      await f.feature.close();
    }
  });

  it.each(['accepted', 'refused'] as const)(
    'ignores a late old %s apply reply after reconnection',
    async (reply) => {
      const first = ownedConnection(),
        replacement = ownedConnection(),
        acceptance = deferred<ManagementOperation>();
      const f = fixture(first, replacement);
      try {
        const context = await f.feature.capture(selection);
        await f.feature.prepare({ contextId: context.contextId, change: { action: 'sync' } });
        const request = {
          contextId: context.contextId,
          planId: plan.planId,
          requestId: 'original-request',
        };
        first.client.apply.mockReturnValueOnce(acceptance.promise);
        const apply = f.feature.apply(request);
        const oldRefusal = expect(apply).rejects.toThrow(/expired|changed/i);
        await vi.waitFor(() => expect(first.client.apply).toHaveBeenCalledTimes(1));
        first.exit();
        await f.feature.capture(selection);
        if (reply === 'accepted') acceptance.resolve(operation('succeeded'));
        else acceptance.reject(new ManagementError('PLAN_STALE', 'Old refusal', 409));
        await oldRefusal;
        const observed = await f.feature.environment({ contextId: context.contextId });
        expect(observed.uncertainApplications).toEqual([
          { contextId: request.contextId, requestId: request.requestId, plan },
        ]);
        await expect(f.gate.launch(['captured-profile'], async () => {})).rejects.toThrow(
          'recovery'
        );
      } finally {
        acceptance.resolve(operation());
        await f.feature.close();
      }
    }
  );

  it('does not let an old follower clear the replacement follower for the same operation', async () => {
    const first = ownedConnection([operation()]),
      replacement = ownedConnection([operation()]),
      oldWait = deferred<ManagementOperation>();
    first.client.wait.mockReturnValueOnce(oldWait.promise);
    const f = fixture(first, replacement);
    try {
      const context = await f.feature.capture(selection);
      first.exit();
      await f.feature.capture(selection);
      expect(replacement.client.wait).toHaveBeenCalledTimes(1);
      oldWait.resolve(operation('succeeded'));
      await nextTurn();
      await f.feature.environment({ contextId: context.contextId });
      expect(replacement.client.wait).toHaveBeenCalledTimes(1);
      await expect(f.gate.launch(['captured-profile'], async () => {})).rejects.toThrow('recovery');
    } finally {
      oldWait.resolve(operation());
      await f.feature.close();
    }
  });

  it('retains a shared environment fence while another captured context is reconnecting', async () => {
    const first = ownedConnection(),
      sibling = ownedConnection(),
      replacement = ownedConnection(),
      inspection = deferred<ManagementEnvironment>();
    const f = fixture(first, sibling, replacement);
    replacement.client.environment.mockReturnValueOnce(inspection.promise);
    try {
      await f.feature.capture(selection);
      const other = await f.feature.capture({ client: 'codex', scope: 'user' });
      first.exit();
      const recapture = f.feature.capture(selection);
      await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(3));
      await f.feature.environment({ contextId: other.contextId });
      await expect(f.gate.launch(['captured-profile'], async () => {})).rejects.toThrow('recovery');
      inspection.resolve(environment());
      await recapture;
      await expect(f.gate.launch(['captured-profile'], async () => 'ready')).resolves.toBe('ready');
    } finally {
      inspection.resolve(environment());
      await f.feature.close();
    }
  });

  it('closes a replacement that finishes opening after application shutdown', async () => {
    const first = ownedConnection(),
      replacement = ownedConnection(),
      opening = deferred<Awaited<ReturnType<CapturedExtensionEnvironment['connect']>>>();
    const f = fixture(first);
    try {
      await f.feature.capture(selection);
      first.exit();
      f.connect.mockReturnValueOnce(opening.promise);
      const recapture = f.feature.capture(selection).catch((error: unknown) => error);
      await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(2));
      const closing = f.feature.close();
      opening.resolve(replacement.connection);
      expect(await recapture).toEqual(new Error('Extension management is closing.'));
      await closing;
      expect(replacement.connection.close).toHaveBeenCalledTimes(1);
      expect(replacement.client.environment).not.toHaveBeenCalled();
      await expect(f.gate.launch(['captured-profile'], async () => 'closed')).resolves.toBe(
        'closed'
      );
    } finally {
      opening.resolve(replacement.connection);
      await f.feature.close();
    }
  });
});
