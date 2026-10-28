import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { MANAGEMENT_ACCESS_CHANGED } from '../../../src/features/extension-management/contracts';
import { useManagedExtensions } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

import type { ManagedExtensionsModel } from '../../../src/features/extension-management/renderer/hooks/useManagedExtensions';

const backend = vi.hoisted(() => ({
  hostStatus: vi.fn(async () => ({ available: false, reason: 'Reopen the desktop browser link.' })),
  capture: vi.fn(async () => ({
    contextId: 'authorized',
    selection: { client: 'claude', scope: 'user' },
  })),
  environment: vi.fn(async () => ({ contextId: 'authorized', entries: [], diagnostics: [] })),
  catalog: vi.fn(async () => ({ items: [], freshness: 'current', diagnostics: [] })),
}));
vi.mock('@renderer/api', () => ({ api: { extensionManagement: backend } }));

it('rechecks a previously unavailable managed panel after a fresh browser grant', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let model: ManagedExtensionsModel | undefined;
  function Harness() {
    model = useManagedExtensions('skill');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    expect(model!.error).toBe('Reopen the desktop browser link.');
    expect(backend.capture).not.toHaveBeenCalled();
    backend.hostStatus.mockResolvedValue({ available: true, reason: '' });
    await act(async () => {
      window.dispatchEvent(new Event(MANAGEMENT_ACCESS_CHANGED));
    });
    expect(model!.error).toBeNull();
    expect(model!.context?.contextId).toBe('authorized');
    expect(backend.capture).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
