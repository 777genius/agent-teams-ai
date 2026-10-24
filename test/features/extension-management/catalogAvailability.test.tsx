import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

import type { ManagedExtensionsModel } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

const backend = vi.hoisted(() => ({
  hostStatus: vi.fn(async () => ({ available: true })),
  capture: vi.fn(async () => ({
    contextId: 'host-a',
    selection: { client: 'claude', scope: 'user' },
  })),
  environment: vi.fn(async () => ({
    contextId: 'engine-a',
    entries: [
      {
        alias: 'installed',
        kind: 'skill',
        source: 'fixture',
        declared: true,
        updateStatus: 'current',
        bindings: [],
      },
    ],
    diagnostics: [],
  })),
  catalog: vi.fn(),
  prepare: vi.fn(async () => {
    throw new Error('Source unavailable');
  }),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));

it('shows installed state and admits source actions while the registry is slow, without replacing action errors', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let rejectCatalog!: (failure: Error) => void;
  backend.catalog.mockReturnValue(
    new Promise((_, reject) => {
      rejectCatalog = reject;
    })
  );
  let current: ManagedExtensionsModel | undefined;
  function Harness() {
    current = useManagedExtensions('skill');
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    expect(current!.installed.map((entry) => entry.alias)).toEqual(['installed']);
    expect(current!.busy).toBe(false);
    expect(current!.catalogLoading).toBe(true);
    await act(async () => {
      await current!.prepare({ action: 'install_skills' });
    });
    expect(backend.prepare).toHaveBeenCalledOnce();
    expect(current!.error).toBe('Source unavailable');
    await act(async () => {
      rejectCatalog(new Error('Registry offline'));
    });
    expect(current!.catalogError).toBe('Registry offline');
    expect(current!.catalogLoading).toBe(false);
    expect(current!.error).toBe('Source unavailable');
    expect(current!.installed).toHaveLength(1);
  } finally {
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
  }
});
