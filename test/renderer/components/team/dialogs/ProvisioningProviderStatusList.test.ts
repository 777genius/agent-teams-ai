import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ProvisioningProviderStatusList,
  createInitialProviderChecks,
} from '@renderer/components/team/dialogs/ProvisioningProviderStatusList';

describe('ProvisioningProviderStatusList', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows waiting for pending provider checks', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProviderStatusList, {
          checks: createInitialProviderChecks(['anthropic', 'codex']),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Anthropic: waiting');
    expect(host.textContent).toContain('Codex: waiting');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
