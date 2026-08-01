import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOpenCodeLocalModelSetup } from './useOpenCodeLocalModelSetup';

import type { OpenCodeLocalModelSetupTarget } from '../openCodeLocalModelSetup';

const apiMock = vi.hoisted(() => ({
  runtimeProviderManagement: { configureLocalProvider: vi.fn() },
  teams: { prepareProvisioning: vi.fn() },
}));

const target: OpenCodeLocalModelSetupTarget = {
  providerId: 'ollama',
  modelId: 'qwen3-30b-32k',
  modelRoute: 'ollama/qwen3-30b-32k',
  presetId: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  privateNetworkApproved: true,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

const HookProbe = ({
  autoSelectContextKey,
  onReady,
  captureAdd,
}: {
  autoSelectContextKey: string;
  onReady: (modelRoute: string) => void;
  captureAdd: (add: (target: OpenCodeLocalModelSetupTarget) => Promise<void>) => void;
}): React.JSX.Element | null => {
  const { addAndTest } = useOpenCodeLocalModelSetup({
    projectPath: '/workspace/sandbox',
    addingMessage: 'Adding',
    chooseProjectMessage: 'Choose a project',
    dependencies: {
      configureLocalProvider: (input) =>
        apiMock.runtimeProviderManagement.configureLocalProvider(input),
      prepareProvisioning: (...args) => apiMock.teams.prepareProvisioning(...args),
    },
    autoSelectContextKey,
    onConfigured: () => undefined,
    onReady,
  });
  useEffect(() => captureAdd(addAndTest), [addAndTest, captureAdd]);
  return null;
};

describe('useOpenCodeLocalModelSetup', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiMock.runtimeProviderManagement.configureLocalProvider.mockReset();
    apiMock.teams.prepareProvisioning.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('does not replace a provider selection changed during a deep test', async () => {
    const readiness = deferred<{ ready: boolean; message: string }>();
    apiMock.runtimeProviderManagement.configureLocalProvider.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      configuration: {
        providerId: 'ollama',
        baseUrl: target.baseUrl,
        modelIds: [target.modelId],
        defaultModelId: target.modelId,
        modelRoute: target.modelRoute,
        configPath: '/workspace/sandbox/opencode.json',
        scope: 'project',
        setAsDefault: false,
      },
    });
    apiMock.teams.prepareProvisioning.mockReturnValue(readiness.promise);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onReady = vi.fn();
    let addAndTest!: (candidate: OpenCodeLocalModelSetupTarget) => Promise<void>;
    const captureAdd = (add: typeof addAndTest): void => {
      addAndTest = add;
    };

    await act(async () => {
      root.render(
        <HookProbe
          autoSelectContextKey='["opencode","opencode",""]'
          onReady={onReady}
          captureAdd={captureAdd}
        />
      );
      await Promise.resolve();
    });
    let setup!: Promise<void>;
    await act(async () => {
      setup = addAndTest(target);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(apiMock.teams.prepareProvisioning).toHaveBeenCalledOnce());

    await act(async () => {
      root.render(
        <HookProbe
          autoSelectContextKey='["anthropic","anthropic","claude-sonnet"]'
          onReady={onReady}
          captureAdd={captureAdd}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        <HookProbe
          autoSelectContextKey='["opencode","opencode",""]'
          onReady={onReady}
          captureAdd={captureAdd}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      readiness.resolve({ ready: true, message: 'Ready.' });
      await setup;
    });

    expect(onReady).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
