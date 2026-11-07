import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const quickConnect = vi.hoisted(() => vi.fn(() => ({
  entries: [],
  loading: false,
  loaded: false,
  authoritativeLoaded: false,
  authoritativePending: true,
  error: null,
  refresh: vi.fn(),
})));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ openCodeRuntimeStatus: { version: '1.17.18' } }),
}));
vi.mock('@features/runtime-provider-management/renderer/hooks/useRuntimeProviderQuickConnect', () => ({
  useRuntimeProviderQuickConnect: quickConnect,
}));

import { OpenCodeSourceDirectoryProvider } from './OpenCodeSourceDirectoryProvider';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  quickConnect.mockClear();
});

describe('OpenCodeSourceDirectoryProvider', () => {
  it('subscribes once to a lightweight directory read for the exact project', async () => {
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        root.render(
          <OpenCodeSourceDirectoryProvider enabled projectPath="/tmp/test-project">
            <span>Dialog</span>
          </OpenCodeSourceDirectoryProvider>
        );
      });
      expect(quickConnect).toHaveBeenCalledWith({
        enabled: true,
        projectPath: '/tmp/test-project',
        runtimeRevision: '1.17.18',
      });

      await act(async () => {
        root.render(
          <OpenCodeSourceDirectoryProvider enabled={false} projectPath="/tmp/test-project">
            <span>Dialog</span>
          </OpenCodeSourceDirectoryProvider>
        );
      });
      expect(quickConnect).toHaveBeenLastCalledWith({
        enabled: false,
        projectPath: '/tmp/test-project',
        runtimeRevision: '1.17.18',
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
