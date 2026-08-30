import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

const providerStatusMock = vi.hoisted(() => ({ current: null as CliProviderStatus | null }));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/hooks/useEffectiveCliProviderStatus', () => ({
  useEffectiveCliProviderStatus: () => ({
    cliStatus: null,
    sourceCliStatus: null,
    providerStatus: providerStatusMock.current,
    loading: false,
    codexSnapshotPending: false,
  }),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children }: { children: React.ReactNode }) =>
    React.createElement('label', null, children),
}));

import { EffortLevelSelector } from './EffortLevelSelector';

function buildCatalogProviderStatus(supportedReasoningEfforts: string[]): CliProviderStatus {
  return {
    providerId: 'codex',
    supported: true,
    authenticated: true,
    verificationState: 'verified',
    modelCatalogRefreshState: 'ready',
    models: ['gpt-5.5'],
    modelAvailability: [],
    capabilities: { teamLaunch: true, oneShot: true },
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'codex',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-07-20T00:00:00.000Z',
      staleAt: '2099-07-20T00:10:00.000Z',
      defaultModelId: 'gpt-5.5',
      defaultLaunchModel: 'gpt-5.5',
      models: [
        {
          id: 'gpt-5.5',
          launchModel: 'gpt-5.5',
          displayName: 'GPT-5.5',
          supportedReasoningEfforts,
        },
      ],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
  } as unknown as CliProviderStatus;
}

async function renderSelector(
  props: Partial<React.ComponentProps<typeof EffortLevelSelector>> & { value: string }
): Promise<() => Promise<void>> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(EffortLevelSelector, {
        onValueChange: vi.fn(),
        providerId: 'codex',
        model: 'gpt-5.5',
        ...props,
      })
    );
  });
  return async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  };
}

describe('EffortLevelSelector', () => {
  it('clears an effort the selected model cannot run without any user interaction', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    providerStatusMock.current = buildCatalogProviderStatus(['low', 'medium', 'high']);
    const onValueChange = vi.fn();

    const unmount = await renderSelector({ value: 'xhigh', onValueChange });

    expect(onValueChange).toHaveBeenCalledWith('');
    await unmount();
  });

  it('leaves an available effort alone', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    providerStatusMock.current = buildCatalogProviderStatus(['low', 'medium', 'high']);
    const onValueChange = vi.fn();

    const unmount = await renderSelector({ value: 'high', onValueChange });

    expect(onValueChange).not.toHaveBeenCalled();
    await unmount();
  });
});
