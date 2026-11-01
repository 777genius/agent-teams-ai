import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenCodeProviderCompatibilityScope,
  OpenCodeProviderCompatibilityStatus,
  useOpenCodeProviderConnectionBlocked,
} from '../../../../src/features/runtime-provider-management/renderer/ui/OpenCodeProviderCompatibilityStatus';

const mocks = vi.hoisted(() => ({ version: '2.1.4' as string | null }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

function ConnectAction({
  providerId,
  authMethod,
}: {
  providerId: string;
  authMethod?: 'oauth' | 'api';
}): React.ReactNode {
  const blocked = useOpenCodeProviderConnectionBlocked(providerId, authMethod);
  const id = authMethod ? `${providerId}-${authMethod}` : providerId;
  return <button type="button" disabled={blocked} data-testid={`connect-action-${id}`}>Connect</button>;
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
      <OpenCodeProviderCompatibilityScope generation={
        mocks.version?.startsWith('2.') ? 'v2' :
          mocks.version?.startsWith('1.') ? 'v1' : null
      }>
        <OpenCodeProviderCompatibilityStatus providerId="cursor-acp" />
        <OpenCodeProviderCompatibilityStatus providerId="openrouter" />
        <OpenCodeProviderCompatibilityStatus providerId="xai" />
        <ConnectAction providerId="cursor-acp" />
        <ConnectAction providerId="xai" />
        <ConnectAction providerId="xai" authMethod="oauth" />
        <ConnectAction providerId="xai" authMethod="api" />
        <OpenCodeProviderCompatibilityStatus providerId="xai" authMethod="oauth" />
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
    expect(host.querySelector<HTMLButtonElement>('[data-testid="connect-action-xai-oauth"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="connect-action-xai-api"]')?.disabled).toBe(false);
    const labels = host.querySelectorAll('[data-testid="runtime-provider-compatibility-xai"]');
    expect(labels[1]?.textContent).toContain('requiresV1');
  });
  it('blocks connection while native status is unavailable without claiming V1', async () => {
    mocks.version = null;
    await show();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="connect-action-cursor-acp"]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="connect-action-xai"]')?.disabled).toBe(true);
    expect(host.querySelectorAll('[data-testid^="runtime-provider-compatibility-"]')).toHaveLength(4);
  });
  it('does not show V2 warnings on an installed V1 runtime', async () => {
    mocks.version = '1.19.5';
    await show();
    expect(host.querySelectorAll('[data-testid^="runtime-provider-compatibility-"]')).toHaveLength(0);
  });
});
