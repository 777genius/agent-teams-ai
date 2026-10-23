import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { expect, it, vi } from 'vitest';

import { CreateTeamProviderStatusStrip, RetryOpenCodeStatus } from './RetryOpenCodeStatus';

import type { ComponentProps } from 'react';

const { fetchCliProviderStatus } = vi.hoisted(() => ({ fetchCliProviderStatus: vi.fn() }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({ fetchCliProviderStatus }),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/components/common/ProviderActivityStatusStrip', () => ({
  ProviderActivityStatusStrip: ({ label }: { label?: string | null }) => <p>{label}</p>,
}));

it('retries only an eligible project failure on an explicit click, without an automatic failure loop', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const props: ComponentProps<typeof RetryOpenCodeStatus> = {
    projectPath: '  /sandbox/mixed-project  ',
    providerStatus: {
      providerId: 'opencode',
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
    },
    loading: false,
    disabled: false,
  };
  let complete!: (result: boolean) => void;
  fetchCliProviderStatus.mockReset().mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      })
  );
  const render = async (overrides: Partial<typeof props> = {}) => {
    await act(async () => root.render(<RetryOpenCodeStatus {...props} {...overrides} />));
  };
  try {
    await render();
    expect(fetchCliProviderStatus).not.toHaveBeenCalled();
    const button = host.querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    expect(fetchCliProviderStatus).toHaveBeenCalledExactlyOnceWith('opencode', {
      projectPath: '/sandbox/mixed-project',
      silent: false,
      checkReason: 'manual_refresh',
    });
    expect(host.querySelector('button')!.disabled).toBe(true);
    await act(async () => host.querySelector('button')!.click());
    expect(fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    await act(async () => complete(false));
    await render();
    expect(host.querySelector('button')!.disabled).toBe(false);
    expect(fetchCliProviderStatus).toHaveBeenCalledTimes(1);

    for (const overrides of [{ loading: true }, { disabled: true }]) {
      await render(overrides);
      expect(host.querySelector('button')!.disabled).toBe(true);
      await act(async () => host.querySelector('button')!.click());
      expect(fetchCliProviderStatus).toHaveBeenCalledTimes(1);
    }
    for (const overrides of [
      { providerStatus: null },
      { projectPath: '   ' },
      {
        providerStatus: { ...props.providerStatus!, statusCheckOutcome: 'authoritative' as const },
      },
      { providerStatus: { ...props.providerStatus!, providerId: 'codex' as const } },
      {
        providerStatus: {
          ...props.providerStatus!,
          statusCheckErrorCode: 'project_missing' as const,
        },
      },
    ]) {
      await render(overrides);
      expect(host.querySelector('button')).toBeNull();
    }
    expect(fetchCliProviderStatus).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('keeps the provider summary visible and offers retry only when OpenCode is selected', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const props: ComponentProps<typeof CreateTeamProviderStatusStrip> = {
    projectPath: '/sandbox/mixed-project',
    disabled: false,
    cliStatus: null,
    cliStatusLoading: false,
    cliProviderStatusLoading: {},
    multimodelEnabled: true,
    label: 'Selected providers',
    providerStatusOverride: {
      providerId: 'opencode',
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
    } as ComponentProps<typeof CreateTeamProviderStatusStrip>['providerStatusOverride'],
  };
  try {
    for (const providerIds of [['codex'] as const, ['opencode'] as const]) {
      await act(async () =>
        root.render(<CreateTeamProviderStatusStrip {...props} providerIds={providerIds} />)
      );
      expect(host.querySelector('p')?.textContent).toBe('Selected providers');
      expect(Boolean(host.querySelector('button'))).toBe(providerIds[0] === 'opencode');
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
