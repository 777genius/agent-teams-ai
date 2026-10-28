import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

import type {
  ExtensionClient,
  ExtensionManagementAPI,
  ManagementCatalog,
  ManagementEnvironment,
} from '../../../src/features/extension-management/contracts';

const backend = vi.hoisted(() => ({
  hostStatus: vi.fn(async () => ({ available: true })),
  capture: vi.fn<ExtensionManagementAPI['capture']>(),
  environment: vi.fn<ExtensionManagementAPI['environment']>(),
  catalog: vi.fn<ExtensionManagementAPI['catalog']>(),
  apply: vi.fn(),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function environment(client: ExtensionClient): ManagementEnvironment {
  return {
    contextId: `engine-${client}`,
    entries: [
      {
        alias: `installed-${client}`,
        kind: 'skill',
        source: 'fixture',
        declared: true,
        updateStatus: 'current',
        bindings: [],
      },
    ],
    diagnostics: [],
  };
}

function catalog(client: ExtensionClient): ManagementCatalog {
  return {
    items: [
      {
        id: `catalog-${client}`,
        name: `catalog-${client}`,
        description: 'Context-specific fixture',
        kind: 'skill',
        source: 'fixture',
        targets: [client],
        available: true,
      },
    ],
    freshness: 'current',
    diagnostics: [],
  };
}

it('keeps the new client rendered when both old-context inventory and catalog responses arrive later', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const oldEnvironment = deferred<ManagementEnvironment>();
  const oldCatalog = deferred<ManagementCatalog>();
  backend.capture.mockImplementation(async (selection) => ({
    contextId: `host-${selection.client}`,
    selection,
    label: selection.client,
    session: {
      apiVersion: 1,
      engineVersion: 'test',
      contextId: `engine-${selection.client}`,
      environmentId: 'shared-environment',
      scope: 'user',
      targets: [],
      capabilities: [],
    },
  }));
  backend.environment.mockImplementation(({ contextId }) =>
    contextId === 'host-claude' ? oldEnvironment.promise : Promise.resolve(environment('opencode'))
  );
  backend.catalog.mockImplementation(({ contextId }) =>
    contextId === 'host-claude' ? oldCatalog.promise : Promise.resolve(catalog('opencode'))
  );
  function Harness() {
    const model = useManagedExtensions('skill');
    return (
      <>
        <button onClick={() => model.setClient('opencode')}>Select OpenCode</button>
        <output data-testid="selection">{model.context?.contextId}</output>
        <output data-testid="inventory">{model.environment?.contextId}</output>
        <output data-testid="installed">
          {model.installed.map((entry) => entry.alias).join(',')}
        </output>
        <output data-testid="catalog">{model.items.map((entry) => entry.id).join(',')}</output>
        <output data-testid="status">{model.busy ? 'loading' : 'ready'}</output>
        <output data-testid="error">{model.error ?? model.catalogError ?? ''}</output>
      </>
    );
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const rendered = (name: string) => host.querySelector(`[data-testid="${name}"]`)?.textContent;
  try {
    await act(async () => root.render(React.createElement(Harness)));
    expect(rendered('selection')).toBe('host-claude');
    expect(backend.environment).toHaveBeenCalledWith({ contextId: 'host-claude' });
    expect(backend.catalog).toHaveBeenCalledWith({ contextId: 'host-claude' });
    await act(async () => host.querySelector('button')!.click());
    expect(rendered('selection')).toBe('host-opencode');
    expect(rendered('inventory')).toBe('engine-opencode');
    expect(rendered('installed')).toBe('installed-opencode');
    expect(rendered('catalog')).toBe('catalog-opencode');
    await act(async () => {
      oldEnvironment.resolve(environment('claude'));
      oldCatalog.resolve(catalog('claude'));
      await Promise.all([oldEnvironment.promise, oldCatalog.promise]);
    });
    expect(rendered('selection')).toBe('host-opencode');
    expect(rendered('inventory')).toBe('engine-opencode');
    expect(rendered('installed')).toBe('installed-opencode');
    expect(rendered('catalog')).toBe('catalog-opencode');
    expect(rendered('status')).toBe('ready');
    expect(rendered('error')).toBe('');
    expect(backend.apply).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
