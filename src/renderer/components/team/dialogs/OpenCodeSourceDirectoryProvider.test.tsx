import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeSourceDirectoryProvider } from './OpenCodeSourceDirectoryProvider';

const storeState = vi.hoisted(() => ({
  current: {
    openCodeRuntimeStatus: {
      installed: true, state: 'ready', version: '1.17.18', binaryPath: '/opt/opencode',
    } as { installed: boolean; state: string; version: string; binaryPath: string } | null,
    openCodeRuntimeStatusLoading: false,
    openCodeRuntimeError: null,
    fetchOpenCodeRuntimeStatus: vi.fn().mockResolvedValue(undefined),
    cliStatus: null,
    cliStatusLoading: false,
  },
}));

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
    selector(storeState.current),
}));
vi.mock('@features/runtime-provider-management/renderer/hooks/useRuntimeProviderQuickConnect', () => ({
  useRuntimeProviderQuickConnect: quickConnect,
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  quickConnect.mockClear();
  storeState.current.openCodeRuntimeStatus = {
    installed: true, state: 'ready', version: '1.17.18', binaryPath: '/opt/opencode',
  };
  storeState.current.fetchOpenCodeRuntimeStatus.mockClear();
});

describe('OpenCodeSourceDirectoryProvider', () => {
  it('does not start directory discovery for a missing runtime', async () => {
    storeState.current.openCodeRuntimeStatus = null;
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        root.render(
          <OpenCodeSourceDirectoryProvider enabled projectPath="/workspace/project">
            <span>Dialog</span>
          </OpenCodeSourceDirectoryProvider>
        );
      });
      expect(quickConnect).toHaveBeenLastCalledWith({
        enabled: false,
        projectPath: '/workspace/project',
        runtimeRevision: null,
      });
      expect(storeState.current.fetchOpenCodeRuntimeStatus).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('starts global source discovery on open before a project is selected', async () => {
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        root.render(
          <OpenCodeSourceDirectoryProvider enabled projectPath={null}>
            <span>Dialog</span>
          </OpenCodeSourceDirectoryProvider>
        );
      });
      expect(quickConnect).toHaveBeenLastCalledWith({
        enabled: true,
        projectPath: null,
        runtimeRevision: JSON.stringify(['ready', '1.17.18', '/opt/opencode']),
      });
      await act(async () => {
        root.render(
          <OpenCodeSourceDirectoryProvider enabled projectPath="/workspace/selected-project">
            <span>Dialog</span>
          </OpenCodeSourceDirectoryProvider>
        );
      });
      expect(quickConnect).toHaveBeenLastCalledWith({
        enabled: true,
        projectPath: '/workspace/selected-project',
        runtimeRevision: JSON.stringify(['ready', '1.17.18', '/opt/opencode']),
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('subscribes once to a lightweight directory read for the exact project', async () => {
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        root.render(
          <OpenCodeSourceDirectoryProvider enabled projectPath="/workspace/test-project">
            <span>Dialog</span>
          </OpenCodeSourceDirectoryProvider>
        );
      });
      expect(quickConnect).toHaveBeenCalledWith({
        enabled: true,
        projectPath: '/workspace/test-project',
        runtimeRevision: JSON.stringify(['ready', '1.17.18', '/opt/opencode']),
      });

      await act(async () => {
        root.render(
          <OpenCodeSourceDirectoryProvider enabled={false} projectPath="/workspace/test-project">
            <span>Dialog</span>
          </OpenCodeSourceDirectoryProvider>
        );
      });
      expect(quickConnect).toHaveBeenLastCalledWith({
        enabled: false,
        projectPath: '/workspace/test-project',
        runtimeRevision: JSON.stringify(['ready', '1.17.18', '/opt/opencode']),
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
