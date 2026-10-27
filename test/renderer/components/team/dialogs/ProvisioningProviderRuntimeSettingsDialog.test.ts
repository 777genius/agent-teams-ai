import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComponentProps } from 'react';

type RuntimeDialogProps = ComponentProps<
  typeof import('@renderer/components/runtime/ProviderRuntimeSettingsDialog').ProviderRuntimeSettingsDialog
>;

const storeState = vi.hoisted(() => ({
  appConfig: null,
  bootstrapCliStatus: vi.fn(),
  cliProviderStatusLoading: {},
  cliStatus: { binaryPath: '/test-fixtures/runtime' },
  cliStatusLoading: false,
  codexRuntimeStatus: null,
  codexRuntimeStatusLoading: false,
  fetchCliProviderStatus: vi.fn(),
  fetchCliStatus: vi.fn(),
  installCodexRuntime: vi.fn(),
  invalidateCliProviderModelCatalog: vi.fn(),
  invalidateCliStatus: vi.fn(),
  updateConfig: vi.fn(),
}));

let runtimeDialogProps: RuntimeDialogProps | null = null;

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/components/runtime/ProviderRuntimeSettingsDialog', () => ({
  ProviderRuntimeSettingsDialog: (props: RuntimeDialogProps) => {
    runtimeDialogProps = props;
    return React.createElement('div', { 'data-project-path': props.projectPath });
  },
}));

vi.mock('@renderer/components/terminal/TerminalModal', () => ({
  TerminalModal: () => null,
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ProvisioningProviderRuntimeSettingsDialog connection refresh', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeDialogProps = null;
    storeState.invalidateCliStatus.mockResolvedValue(undefined);
    storeState.fetchCliProviderStatus.mockResolvedValue(true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    host.remove();
  });

  async function renderDialog(
    providerId: 'anthropic' | 'codex' | 'opencode',
    onProviderRuntimeChanged = vi.fn()
  ) {
    const { ProvisioningProviderRuntimeSettingsDialog } =
      await import('@renderer/components/team/dialogs/ProvisioningProviderRuntimeSettingsDialog');
    await act(async () => {
      root.render(
        React.createElement(ProvisioningProviderRuntimeSettingsDialog, {
          openProviderId: providerId,
          onOpenProviderIdChange: vi.fn(),
          providers: [{ providerId }] as RuntimeDialogProps['providers'],
          projectPath: '/test-fixtures/project',
          onProviderRuntimeChanged,
        })
      );
      await Promise.resolve();
    });
    return onProviderRuntimeChanged;
  }

  it.each(['anthropic', 'codex', 'opencode'] as const)(
    'waits for main invalidation before checking the replacement %s connection',
    async (providerId) => {
      const invalidation = deferred();
      const replacementStatus = deferred();
      storeState.invalidateCliStatus.mockReturnValue(invalidation.promise);
      storeState.fetchCliProviderStatus.mockImplementation(async () => {
        await replacementStatus.promise;
        return true;
      });
      const onProviderRuntimeChanged = await renderDialog(providerId);

      const refresh = runtimeDialogProps!.onRefreshProvider!(providerId, 'provider_change');
      expect(storeState.invalidateCliStatus).toHaveBeenCalledOnce();
      // A renderer-only invalidation cannot retire the main process's old catalog request.
      // Do not begin a replacement read until main has acknowledged its invalidation.
      expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
      expect(onProviderRuntimeChanged).not.toHaveBeenCalled();

      invalidation.resolve();
      await vi.waitFor(() => {
        expect(storeState.fetchCliProviderStatus).toHaveBeenCalledExactlyOnceWith(providerId, {
          silent: false,
          checkReason: 'provider_change',
        });
      });
      expect(onProviderRuntimeChanged).not.toHaveBeenCalled();
      expect(runtimeDialogProps!.projectPath).toBe('/test-fixtures/project');

      replacementStatus.resolve();
      await expect(refresh).resolves.toBe(true);
      expect(onProviderRuntimeChanged).toHaveBeenCalledExactlyOnceWith(providerId);
    }
  );

  it('does not check or announce a replacement connection if main invalidation fails', async () => {
    const failure = new Error('Main provider status invalidation failed');
    const invalidation = deferred();
    void invalidation.promise.catch(() => undefined);
    storeState.invalidateCliStatus.mockReturnValue(invalidation.promise);
    const onProviderRuntimeChanged = await renderDialog('anthropic');

    const refresh = runtimeDialogProps!.onRefreshProvider!('anthropic', 'provider_change');
    const rejectedRefresh = expect(refresh).rejects.toThrow(failure);
    invalidation.reject(failure);

    await rejectedRefresh;
    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    expect(onProviderRuntimeChanged).not.toHaveBeenCalled();
  });
});
