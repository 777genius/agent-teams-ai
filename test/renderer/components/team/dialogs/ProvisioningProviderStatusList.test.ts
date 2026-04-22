import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deriveEffectiveProvisioningPrepareState,
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
              backendSummary: 'Codex native',
              details: [
                '5.4 Mini - verified',
                '5.1 Codex Max - unavailable - Not available on this Codex native runtime',
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Codex (Codex native): Selected model checks - 1 model unavailable, 1 verified'
    );
    expect(host.textContent).toContain('5.4 Mini - verified');
    expect(host.textContent).toContain(
      '5.1 Codex Max - unavailable - Not available on this Codex native runtime'
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
            '5.1 Codex Max - unavailable - Not available on this Codex native runtime',
          ],
        },
      ])
    ).toBe('5.1 Codex Max - unavailable - Not available on this Codex native runtime');
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
              backendSummary: 'Codex native',
              details: ['5.3 Codex - check failed - Model verification timed out'],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Codex (Codex native): Selected model checks - 1 model timed out'
    );
    expect(host.textContent).toContain('5.3 Codex - check failed - Model verification timed out');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('summarizes compatibility-pending OpenCode model checks separately from verified ones', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProviderStatusList, {
          checks: [
            {
              providerId: 'opencode',
              status: 'checking',
              backendSummary: 'OpenCode CLI',
              details: [
                'minimax-m2.5-free - compatible, deep verification pending...',
                'nemotron-3-super-free - verified',
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'OpenCode (OpenCode CLI): Selected model checks - 1 compatible, deep verification pending, 1 verified'
    );
    expect(host.textContent).toContain(
      'minimax-m2.5-free - compatible, deep verification pending...'
    );
    expect(host.textContent).toContain('nemotron-3-super-free - verified');

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
              backendSummary: 'Codex native',
              details: [
                'Preflight check for `orchestrator-cli -p` did not complete. Proceeding anyway. Details: Timeout running: orchestrator-cli -p Output only the single word PONG. --output-format text --model gpt-5.4-mini --max-turns 1 --no-session-persistence',
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex (Codex native): CLI preflight did not complete');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps internal native rollout state visible in provisioning backend summaries', () => {
    expect(
      getProvisioningProviderBackendSummary({
        providerId: 'codex',
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
            state: 'ready',
            audience: 'general',
            statusMessage: 'Ready',
          },
        ],
      })
    ).toBe('Codex native');
  });

  it('normalizes persisted legacy codex fallback summaries to Codex native', () => {
    expect(
      getProvisioningProviderBackendSummary({
        providerId: 'codex',
        selectedBackendId: 'api',
        resolvedBackendId: 'api',
        backend: {
          kind: 'codex-native',
          label: 'Codex native',
        },
        availableBackends: [
          {
            id: 'codex-native',
            label: 'Codex native',
            description: 'Use codex exec JSON mode.',
            selectable: true,
            recommended: true,
            available: true,
            state: 'ready',
            audience: 'general',
          },
        ],
      })
    ).toBe('Codex native');
  });

  it('promotes loading to ready once every provider check is already terminal', () => {
    expect(
      deriveEffectiveProvisioningPrepareState({
        state: 'loading',
        message: 'Checking selected providers in parallel...',
        warnings: [],
        checks: [
          {
            providerId: 'codex',
            status: 'ready',
            details: ['5.4 - verified', 'Default - verified'],
          },
          {
            providerId: 'opencode',
            status: 'ready',
            details: ['minimax-m2.5-free - verified', 'nemotron-3-super-free - verified'],
          },
        ],
      })
    ).toEqual({
      state: 'ready',
      message: 'Selected providers are ready.',
    });
  });

  it('promotes loading to failed once a terminal provider failure is already known', () => {
    expect(
      deriveEffectiveProvisioningPrepareState({
        state: 'loading',
        message: 'Checking selected providers in parallel...',
        warnings: [],
        checks: [
          {
            providerId: 'opencode',
            status: 'failed',
            details: [
              'nemotron-3-super-free - unavailable - OpenCode production E2E evidence artifact has no entry for selected model opencode/nemotron-3-super-free',
            ],
          },
        ],
      })
    ).toEqual({
      state: 'failed',
      message:
        'nemotron-3-super-free - unavailable - OpenCode production E2E evidence artifact has no entry for selected model opencode/nemotron-3-super-free',
    });
  });

  it('shows a more honest loading message while OpenCode deep verification is still pending', () => {
    expect(
      deriveEffectiveProvisioningPrepareState({
        state: 'loading',
        message: 'Checking selected providers in parallel...',
        warnings: [],
        checks: [
          {
            providerId: 'opencode',
            status: 'checking',
            details: [
              'minimax-m2.5-free - compatible, deep verification pending...',
              'nemotron-3-super-free - compatible, deep verification pending...',
            ],
          },
        ],
      })
    ).toEqual({
      state: 'loading',
      message:
        'Deep verification is still running. OpenCode free models may take around 20 seconds.',
    });
  });
});
