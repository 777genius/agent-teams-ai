import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

import type {
  ExtensionManagementAPI,
  ManagementEnvironment,
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
  cancel: vi.fn<ExtensionManagementAPI['cancel']>(),
  apply: vi.fn(),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));

it('refreshes authoritative inventory after terminal cancellation and ignores the old poll without repeating Apply', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
    createdAt: '2026-10-25T00:00:00Z',
    updatedAt: '2026-10-25T00:00:00Z',
  };
  const terminal: ManagementOperation = {
    ...running,
    state: 'canceled',
    result: { outcome: 'canceled', mutated: false, items: [], nextActions: [], message: '' },
  };
  const refreshed: ManagementEnvironment = {
    contextId: 'engine-a',
    entries: [
      {
        alias: 'preserved-plugin',
        kind: 'plugin',
        source: 'fixture/preserved',
        declared: true,
        updateStatus: 'current',
        bindings: [],
      },
    ],
    diagnostics: [],
    pendingOperations: [],
  };
  backend.environment
    .mockResolvedValue(refreshed)
    .mockResolvedValueOnce({ ...refreshed, entries: [], pendingOperations: [running] });
  let releasePoll!: (value: ManagementOperation) => void;
  const oldPoll = new Promise<ManagementOperation>((resolve) => {
    releasePoll = resolve;
  });
  backend.operation.mockReturnValue(oldPoll);
  backend.cancel.mockResolvedValue(terminal);
  let current: ManagedExtensionsModel | undefined;
  function Harness() {
    current = useManagedExtensions('plugin');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    expect(current!.environment?.pendingOperations).toEqual([running]);
    expect(backend.operation).toHaveBeenCalledOnce();
    await act(async () => {
      await current!.cancel();
    });
    expect(backend.cancel).toHaveBeenCalledExactlyOnceWith({
      contextId: 'host-a',
      operationId: 'operation-a',
    });
    expect(backend.environment).toHaveBeenCalledTimes(2);
    expect(current!.environment).toEqual(refreshed);
    expect(current!.operation).toEqual(terminal);
    expect(current!.isRunning).toBe(false);
    await act(async () => {
      releasePoll(running);
      await oldPoll;
    });
    expect(current!.operation).toEqual(terminal);
    expect(current!.environment).toEqual(refreshed);
    expect(backend.operation).toHaveBeenCalledOnce();
    expect(backend.apply).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
