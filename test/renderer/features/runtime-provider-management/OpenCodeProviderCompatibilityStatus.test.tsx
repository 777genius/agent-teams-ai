import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenCodeProviderCompatibilityScope,
  OpenCodeProviderCompatibilityStatus,
  useOpenCodeProviderConnectionBlocked,
} from '../../../../src/features/runtime-provider-management/renderer/ui/OpenCodeProviderCompatibilityStatus';

const mocks = vi.hoisted(() => ({ version: '2.1.4' as string | null }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({
    openCodeRuntimeStatus: mocks.version
      ? { installed: true, version: mocks.version, state: 'ready' } : null,
  }),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

function ConnectAction({ providerId }: { providerId: string }): React.ReactNode {
  const blocked = useOpenCodeProviderConnectionBlocked(providerId);
  return <button type="button" disabled={blocked} data-testid={`connect-action-${providerId}`}>Connect</button>;
}

describe('OpenCode provider compatibility in advanced settings', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.version = '2.1.4';
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function show(): Promise<void> {
    await act(async () => root.render(
      <OpenCodeProviderCompatibilityScope>
        <OpenCodeProviderCompatibilityStatus providerId="cursor-acp" />
        <OpenCodeProviderCompatibilityStatus providerId="openrouter" />
        <OpenCodeProviderCompatibilityStatus providerId="xai" />
        <ConnectAction providerId="cursor-acp" />
        <ConnectAction providerId="xai" />
      </OpenCodeProviderCompatibilityScope>
    ));
  }
  it('labels a V2-unadapted CLI and distinguishes unverified API-key providers', async () => {
    await show();
    expect(host.querySelector('[data-testid="runtime-provider-compatibility-cursor-acp"]')?.textContent)
      .toContain('requiresV1');
    for (const id of ['openrouter', 'xai']) {
      expect(host.querySelector(`[data-testid="runtime-provider-compatibility-${id}"]`)?.textContent)
        .toContain('v2Unverified');
    }
    expect(host.querySelector<HTMLButtonElement>('[data-testid="connect-action-cursor-acp"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="connect-action-xai"]')?.disabled).toBe(false);
  });
  it('does not infer an installed generation from an unavailable OpenCode runtime', async () => {
    mocks.version = null;
    await show();
    expect(host.querySelectorAll('[data-testid^="runtime-provider-compatibility-"]')).toHaveLength(0);
  });
  it('does not show V2 warnings on an installed V1 runtime', async () => {
    mocks.version = '1.19.5';
    await show();
    expect(host.querySelectorAll('[data-testid^="runtime-provider-compatibility-"]')).toHaveLength(0);
  });
});
