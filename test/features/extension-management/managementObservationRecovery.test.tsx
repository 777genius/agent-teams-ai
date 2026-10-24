import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

import type {
  ExtensionManagementAPI,
  ManagementOperation,
} from '../../../src/features/extension-management/contracts';
import type { ManagedExtensionsModel } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

const backend = vi.hoisted(() => ({
  hostStatus: vi.fn(async () => ({ available: true })),
  capture: vi.fn(async () => ({
    contextId: 'host-a',
    selection: { client: 'claude', scope: 'user' },
  })),
  environment: vi.fn<ExtensionManagementAPI['environment']>(),
  catalog: vi.fn(async () => ({ items: [], freshness: 'current', diagnostics: [] })),
  operation: vi.fn<ExtensionManagementAPI['operation']>(),
  apply: vi.fn(),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));

it('resumes read-only observation after a transient failure and shows the actual terminal result without another mutation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const running: ManagementOperation = {
    operationId: 'operation-a',
    requestId: 'request-a',
    planId: 'plan-a',
    contextId: 'engine-a',
    environmentId: 'environment-a',
    action: 'install',
    state: 'running',
    phase: 'apply',
    completed: 0,
    total: 1,
    items: [],
    diagnostics: [],
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
  };
  backend.environment
    .mockResolvedValue({
      contextId: 'engine-a',
      entries: [],
      diagnostics: [],
      pendingOperations: [],
    })
    .mockResolvedValueOnce({
      contextId: 'engine-a',
      entries: [],
      diagnostics: [],
      pendingOperations: [running],
    });
  backend.operation
    .mockRejectedValueOnce(new Error('Temporary observation failure'))
    .mockResolvedValueOnce({ ...running, state: 'succeeded', completed: 1 });
  let current: ManagedExtensionsModel | undefined;
  function Harness() {
    current = useManagedExtensions('plugin');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    expect(current!.error).toBe('Temporary observation failure');
    expect(current!.isRunning).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(backend.operation).toHaveBeenCalledTimes(2);
    expect(backend.operation.mock.calls[0]).toEqual(backend.operation.mock.calls[1]);
    expect(current!.operation?.state).toBe('succeeded');
    expect(current!.error).toBeNull();
    expect(current!.isRunning).toBe(false);
    expect(backend.apply).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
