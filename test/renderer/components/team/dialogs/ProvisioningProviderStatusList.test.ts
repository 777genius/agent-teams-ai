import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getPrimaryProvisioningFailureDetail,
  getProvisioningProviderBackendSummary,
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

  it('surfaces mixed selected model diagnostics without hiding verified results', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProviderStatusList, {
          checks: [
            {
              providerId: 'codex',
              status: 'failed',
              backendSummary: 'Default adapter',
              details: [
                '5.4 Mini - verified',
                '5.1 Codex Max - unavailable - Not available with Codex ChatGPT subscription',
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Codex (Default adapter): Selected model checks - 1 model unavailable, 1 verified'
    );
    expect(host.textContent).toContain('5.4 Mini - verified');
    expect(host.textContent).toContain(
      '5.1 Codex Max - unavailable - Not available with Codex ChatGPT subscription'
    );

    const detailLines = Array.from(host.querySelectorAll('p'));
    expect(detailLines[0]?.className).toContain('text-emerald-400');
    expect(detailLines[1]?.className).toContain('text-red-300');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('picks the first real failure detail instead of a verified line', () => {
    expect(
      getPrimaryProvisioningFailureDetail([
        {
          providerId: 'codex',
          status: 'failed',
          details: [
            '5.2 - verified',
            '5.3 Codex - check failed - Model verification timed out',
            '5.1 Codex Max - unavailable - Not available with Codex ChatGPT subscription',
          ],
        },
      ])
    ).toBe('5.1 Codex Max - unavailable - Not available with Codex ChatGPT subscription');
  });

  it('summarizes timed out model verification separately from hard failures', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProviderStatusList, {
          checks: [
            {
              providerId: 'codex',
              status: 'notes',
              backendSummary: 'Default adapter',
              details: ['5.3 Codex - check failed - Model verification timed out'],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Codex (Default adapter): Selected model checks - 1 model timed out'
    );
    expect(host.textContent).toContain('5.3 Codex - check failed - Model verification timed out');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('normalizes generic preflight timeout notes without depending on a hardcoded CLI name', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProviderStatusList, {
          checks: [
            {
              providerId: 'codex',
              status: 'notes',
              backendSummary: 'Default adapter',
              details: [
                'Preflight check for `orchestrator-cli -p` did not complete. Proceeding anyway. Details: Timeout running: orchestrator-cli -p Output only the single word PONG. --output-format text --model gpt-5.4-mini --max-turns 1 --no-session-persistence',
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex (Default adapter): CLI preflight did not complete');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps internal native rollout state visible in provisioning backend summaries', () => {
    expect(
      getProvisioningProviderBackendSummary({
        selectedBackendId: 'codex-native',
        resolvedBackendId: 'codex-native',
        backend: {
          kind: 'codex-native',
          label: 'Codex native',
        },
        availableBackends: [
          {
            id: 'codex-native',
            label: 'Codex native',
            description: 'Use codex exec JSON mode.',
            selectable: false,
            recommended: false,
            available: true,
            state: 'locked',
            audience: 'internal',
            statusMessage: 'Ready but locked',
          },
        ],
      })
    ).toBe('Codex native - internal, locked');
  });
});
