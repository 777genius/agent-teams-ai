import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeProviderOnboardingDialog } from '../../../../src/features/runtime-provider-management/renderer/RuntimeProviderOnboardingDialog';

const mocks = vi.hoisted(() => ({
  cancelConnect: vi.fn(),
  savingProviderId: null as string | null,
  setupForm: null as { method: 'api' | 'oauth'; authOptions?: readonly never[] } | null,
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => (key === 'actions.close' ? 'Close' : key) }),
}));

vi.mock(
  '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderOnboarding',
  () => ({
    useRuntimeProviderOnboarding: () => [
      {
        management: {
          setupForm: mocks.setupForm,
          selectedAuthOptionId: null,
          savingProviderId: mocks.savingProviderId,
        },
      },
      {
        management: {
          cancelConnect: mocks.cancelConnect,
        },
      },
    ],
  })
);

vi.mock(
  '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderOnboardingView',
  () => ({
    RuntimeProviderOnboardingView: ({ onDone }: { onDone: () => void }) =>
      React.createElement('button', { onClick: onDone }, 'Finish setup'),
  })
);

describe('RuntimeProviderOnboardingDialog', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.cancelConnect.mockReset();
    mocks.savingProviderId = null;
    mocks.setupForm = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const renderDialog = async (onOpenChange: (open: boolean) => void): Promise<void> => {
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderOnboardingDialog, {
          open: true,
          onOpenChange,
          mode: 'provider',
          providerId: 'xai',
          runtimeGate: 'ready',
          onInstallOrUpdateRuntime: vi.fn(),
          onAdvancedSettings: vi.fn(),
        })
      );
    });
  };

  it('cancels an active OAuth flow when the dialog close control is used', async () => {
    const onOpenChange = vi.fn();
    await renderDialog(onOpenChange);

    const closeButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Close'
    );
    await act(async () => closeButton?.click());

    expect(mocks.cancelConnect).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not cancel the connection after the guided flow finishes normally', async () => {
    const onOpenChange = vi.fn();
    await renderDialog(onOpenChange);

    const finishButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Finish setup'
    );
    await act(async () => finishButton?.click());

    expect(mocks.cancelConnect).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('blocks dismiss while a non-cancellable API credential write is still running', async () => {
    mocks.savingProviderId = 'xai';
    mocks.setupForm = { method: 'api', authOptions: [] };
    const onOpenChange = vi.fn();
    await renderDialog(onOpenChange);

    const closeButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Close'
    );
    expect(closeButton?.disabled).toBe(true);
    await act(async () => closeButton?.click());

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mocks.cancelConnect).not.toHaveBeenCalled();
  });
});
