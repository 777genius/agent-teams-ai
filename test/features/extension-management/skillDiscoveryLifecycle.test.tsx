import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

import type { ExtensionManagementAPI } from '../../../src/features/extension-management/contracts';
import type { ManagedExtensionsModel } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

const backend = vi.hoisted(() => ({
  hostStatus: vi.fn(async () => ({ available: true })),
  capture: vi.fn(async () => ({
    contextId: 'host-a',
    selection: { client: 'claude', scope: 'user' },
  })),
  environment: vi.fn(async () => ({ contextId: 'engine-a', entries: [], diagnostics: [] })),
  catalog: vi.fn(async () => ({ items: [], freshness: 'current', diagnostics: [] })),
  discoverSkills: vi.fn<ExtensionManagementAPI['discoverSkills']>(),
  discardSkillCatalog: vi.fn(async () => {}),
  previewSkill: vi.fn(async () => ({
    catalogId: 'catalog-a',
    candidateId: 'candidate-a',
    markdown: '# Preview',
    diagnostics: [],
  })),
  prepare: vi.fn(async () => ({
    planId: 'retained-plan',
    contextId: 'engine-a',
    action: 'install_skills',
    expiresAt: '2099-01-01T00:00:00Z',
    confirmable: true,
    actions: [],
    warnings: [],
    conflicts: [],
  })),
  discardPlan: vi.fn(async () => {}),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));
const catalog = {
  catalogId: 'catalog-a',
  source: 'https://fixture.invalid',
  candidates: [],
  diagnostics: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  backend.discoverSkills.mockReset().mockResolvedValue(catalog);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => vi.unstubAllGlobals());

it('keeps discovery through preview and back, but releases it on close without discarding a prepared plan', async () => {
  let current: ManagedExtensionsModel | undefined;
  function Harness() {
    current = useManagedExtensions('skill');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await act(async () => {
      await current!.discover(catalog.source);
    });
    await act(async () => {
      await current!.previewSkill('candidate-a');
    });
    await act(async () => {
      current!.setPreview(null);
    });
    expect(current!.candidates?.catalogId).toBe('catalog-a');
    expect(backend.discardSkillCatalog).not.toHaveBeenCalled();
    await act(async () => {
      await current!.prepare({
        action: 'install_skills',
        catalogId: 'catalog-a',
        candidateIds: ['candidate-a'],
      });
    });
    await act(async () => {
      await current!.closeDiscovery();
    });
    expect(backend.discardSkillCatalog).toHaveBeenCalledWith({
      contextId: 'host-a',
      catalogId: 'catalog-a',
    });
    expect(current!.candidates).toBeNull();
    expect(current!.plan?.planId).toBe('retained-plan');
    expect(backend.discardPlan).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it('releases each replaced discovery so a long-lived context does not accumulate seventeen catalogs', async () => {
  let current: ManagedExtensionsModel | undefined;
  function Harness() {
    current = useManagedExtensions('skill');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    for (let index = 0; index < 17; index += 1) {
      backend.discoverSkills.mockResolvedValueOnce({ ...catalog, catalogId: `catalog-${index}` });
      await act(async () => {
        await current!.discover(catalog.source);
      });
    }
    expect(current!.candidates?.catalogId).toBe('catalog-16');
    expect(backend.discardSkillCatalog).toHaveBeenCalledTimes(16);
  } finally {
    await act(async () => root.unmount());
  }
  expect(backend.discardSkillCatalog).toHaveBeenLastCalledWith({
    contextId: 'host-a',
    catalogId: 'catalog-16',
  });
});

it('discards an acquisition that finishes after its source dialog has already closed', async () => {
  let current: ManagedExtensionsModel | undefined;
  let complete!: (value: typeof catalog) => void;
  backend.discoverSkills.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    })
  );
  function Harness() {
    current = useManagedExtensions('skill');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });
    let discovery!: Promise<void>;
    await act(async () => {
      discovery = current!.discover(catalog.source);
    });
    await act(async () => {
      await current!.closeDiscovery();
    });
    await act(async () => {
      complete(catalog);
      await discovery;
    });
    expect(current!.candidates).toBeNull();
    expect(backend.discardSkillCatalog).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
