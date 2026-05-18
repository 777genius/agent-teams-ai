import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deriveEffectiveProvisioningPrepareState,
  getPrimaryProvisioningFailureDetail,
  getProvisioningFailureHint,
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
                '5.4 Mini - available for launch',
                '5.1 Codex Max - unavailable - Not available on this Codex native runtime',
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Codex (Codex native): Selected model checks - 1 model unavailable, 1 available'
    );
    expect(host.textContent).toContain('5.4 Mini - available for launch');
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

  it('keeps OpenCode runtime connectivity failures out of selected-model summaries', async () => {
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
              status: 'failed',
              backendSummary: 'OpenCode CLI',
              details: [
                'OpenCode /experimental/tool/ids unavailable - Unable to connect. Is the computer able to access the url?',
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenCode (OpenCode CLI): OpenCode app MCP unreachable');
    expect(host.textContent).not.toContain('Selected model checks');
    expect(host.textContent).not.toContain('model unavailable');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('gives a concrete hint for missing OpenCode runtime binary failures', () => {
    expect(
      getProvisioningFailureHint('Runtime environment is not available - launch is blocked', [
        {
          providerId: 'opencode',
          status: 'failed',
          backendSummary: null,
          details: [
            'OpenCode runtime binary is not installed or not reachable by launch preflight.',
          ],
        },
      ])
    ).toBe(
      'Install or retry OpenCode runtime from the provider status card, then reopen this dialog.'
    );
  });

  it('gives a concrete hint for stale OpenCode app MCP bridge failures', () => {
    expect(
      getProvisioningFailureHint('Runtime environment is not available - launch is blocked', [
        {
          providerId: 'opencode',
          status: 'failed',
          backendSummary: null,
          details: [
            'OpenCode app MCP is unreachable. Retry launch to refresh the app MCP bridge. Details: Unable to connect. Is the computer able to access the url?',
          ],
        },
      ])
    ).toBe(
      'Retry launch to refresh the OpenCode app MCP bridge. If it repeats, restart the app and OpenCode runtime.'
    );
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

  it('summarizes OpenCode advisory ping misses without failure wording', async () => {
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
              status: 'notes',
              backendSummary: 'OpenCode CLI',
              details: ['big-pickle - ping not confirmed'],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'OpenCode (OpenCode CLI): Selected model checks - 1 ping not confirmed'
    );
    expect(host.textContent).not.toContain('model check failed');
    expect(host.textContent).not.toContain('Needs attention');

    const detailLines = Array.from(host.querySelectorAll('p'));
    expect(detailLines[0]?.className).toContain('text-[var(--color-text-muted)]');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('summarizes OpenCode busy model checks as deferred notes', async () => {
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
              status: 'notes',
              backendSummary: 'OpenCode CLI',
              details: [
                'qwen/qwen3-235b-a22b-thinking-2507 - verification deferred - OpenCode session is busy; retry when idle.',
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'OpenCode (OpenCode CLI): Selected model checks - 1 verification deferred'
    );
    expect(host.textContent).not.toContain('model check failed');
    expect(host.textContent).not.toContain('Needs attention');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not count generic one-shot diagnostic timeouts as model timeouts', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProviderStatusList, {
          checks: [
            {
              providerId: 'anthropic',
              status: 'notes',
              details: [
                'One-shot diagnostic timed out after runtime readiness passed. This does not mark selected models unavailable. Details: Model verification timed out',
                'Opus 4.6 - available for launch',
                'Opus 4.7 - available for launch',
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Anthropic: Selected model checks - 2 available');
    expect(host.textContent).not.toContain('1 model timed out');
    expect(host.textContent).toContain(
      'One-shot diagnostic timed out after runtime readiness passed'
    );

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

  it('does not show non-blocking Codex degraded backend state in provisioning summaries', () => {
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
            state: 'degraded',
            audience: 'general',
            statusMessage: 'Ready with degraded account verification.',
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
            details: ['nemotron-3-super-free - unavailable - selected model is not available'],
          },
        ],
      })
    ).toEqual({
      state: 'failed',
      message: 'nemotron-3-super-free - unavailable - selected model is not available',
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
