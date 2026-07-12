import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type RuntimeProviderCompanionState,
  useRuntimeProviderCompanion,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderCompanion';

import type {
  RuntimeProviderCompanionIdDto,
  RuntimeProviderCompanionStatusDto,
} from '../../../../src/features/runtime-provider-management/contracts';

const mocks = vi.hoisted(() => ({
  getCompanionStatus: vi.fn(),
  installAndConnectCompanion: vi.fn(),
  connectCompanion: vi.fn(),
  progressListener: null as ((status: RuntimeProviderCompanionStatusDto) => void) | null,
}));

vi.mock('@renderer/api', () => ({
  api: {
    runtimeProviderManagement: {
      getCompanionStatus: mocks.getCompanionStatus,
      installAndConnectCompanion: mocks.installAndConnectCompanion,
      connectCompanion: mocks.connectCompanion,
      onCompanionProgress: (listener: (status: RuntimeProviderCompanionStatusDto) => void) => {
        mocks.progressListener = listener;
        return () => {
          if (mocks.progressListener === listener) mocks.progressListener = null;
        };
      },
    },
  },
}));

function companionStatus(
  companionId: RuntimeProviderCompanionIdDto,
  overrides: Partial<RuntimeProviderCompanionStatusDto> = {}
): RuntimeProviderCompanionStatusDto {
  const cursor = companionId === 'cursor-agent';
  return {
    companionId,
    displayName: cursor ? 'Cursor Agent CLI' : 'Kiro CLI',
    phase: 'sign-in-required',
    installed: true,
    authenticated: false,
    binaryPath: cursor ? '/home/test/.local/bin/cursor-agent' : '/home/test/.local/bin/kiro-cli',
    version: '1.0.0',
    percent: null,
    message: 'Sign in required',
    detail: null,
    error: null,
    manualCommand: 'install command',
    manualUrl: 'https://example.test/guide',
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('useRuntimeProviderCompanion', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let current: RuntimeProviderCompanionState | null = null;

  function Harness({ companionId }: { companionId: RuntimeProviderCompanionIdDto }) {
    current = useRuntimeProviderCompanion(companionId, true, '/tmp/provider-companion-test');
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.getCompanionStatus.mockReset();
    mocks.installAndConnectCompanion.mockReset();
    mocks.connectCompanion.mockReset();
    mocks.progressListener = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    current = null;
  });

  it('routes status and operations through the selected companion id', async () => {
    const initial = companionStatus('cursor-agent');
    const connected = companionStatus('cursor-agent', {
      phase: 'connected',
      authenticated: true,
      percent: 100,
    });
    mocks.getCompanionStatus.mockResolvedValue(initial);
    mocks.installAndConnectCompanion.mockResolvedValue(connected);

    await act(async () =>
      root.render(React.createElement(Harness, { companionId: 'cursor-agent' }))
    );
    await act(async () => Promise.resolve());

    expect(mocks.getCompanionStatus).toHaveBeenCalledWith({
      companionId: 'cursor-agent',
      projectPath: '/tmp/provider-companion-test',
    });
    await act(async () => current?.runInstallAndConnect());
    expect(mocks.installAndConnectCompanion).toHaveBeenCalledWith({
      companionId: 'cursor-agent',
      projectPath: '/tmp/provider-companion-test',
    });
    expect(current?.status?.phase).toBe('connected');
  });

  it('ignores progress events emitted for another companion', async () => {
    mocks.getCompanionStatus.mockResolvedValue(companionStatus('cursor-agent'));
    await act(async () =>
      root.render(React.createElement(Harness, { companionId: 'cursor-agent' }))
    );
    await act(async () => Promise.resolve());

    act(() => {
      mocks.progressListener?.(companionStatus('kiro-cli', { phase: 'installing', percent: 42 }));
    });
    expect(current?.status?.companionId).toBe('cursor-agent');
    expect(current?.status?.phase).toBe('sign-in-required');

    act(() => {
      mocks.progressListener?.(
        companionStatus('cursor-agent', { phase: 'installing', percent: 42 })
      );
    });
    expect(current?.status?.phase).toBe('installing');
    expect(current?.status?.percent).toBe(42);
  });
});
