import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createInitialProviderChecks,
  deriveEffectiveProvisioningPrepareState,
  getPrimaryProvisioningFailureDetail,
  getProvisioningFailureHint,
  getProvisioningProviderBackendSummary,
  getProvisioningProviderProgressMessage,
  getProvisioningProviderReadyById,
  ProvisioningProviderStatusList,
} from '@renderer/components/team/dialogs/ProvisioningProviderStatusList';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(host.textContent).toContain('5.4 Mini - Selected model available');
    expect(host.textContent).toContain(
      '5.1 Codex Max - Selected model unavailable: Not available on this Codex native runtime'
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
    const onOpenProviderSettings = vi.fn();

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
          onOpenProviderSettings,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenCode (OpenCode CLI): OpenCode app MCP unreachable');
    expect(host.textContent).not.toContain('Selected model checks');
    expect(host.textContent).not.toContain('model unavailable');
    expect(host.querySelector('button')).toBeNull();

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

  it('gives a concrete hint for an outdated OpenCode runtime', () => {
    expect(
      getProvisioningFailureHint('Runtime environment is not available - launch is blocked', [
        {
          providerId: 'opencode',
          status: 'failed',
          backendSummary: null,
          details: ['OpenCode 1.15.6 is below supported minimum 1.16.0'],
        },
      ])
    ).toBe('Update OpenCode from the provider status card, then retry launch.');
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

  it('gives a concrete hint for OpenCode bridge no-output failures', () => {
    expect(
      getProvisioningFailureHint('Runtime environment is not available - launch is blocked', [
        {
          providerId: 'opencode',
          status: 'failed',
          backendSummary: null,
          details: [
            'OpenCode readiness bridge failed: contract_violation: Bridge stdout was empty',
          ],
        },
      ])
    ).toBe('Restart the app and OpenCode runtime, then retry. If it repeats, copy diagnostics.');
  });

  it('renders Copy diagnostics for OpenCode support diagnostics and copies the prepared payload', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
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
              details: ['OpenCode runtime check returned no output.'],
              supportDiagnostics: [
                {
                  id: 'diag-empty-stdout',
                  providerId: 'opencode',
                  kind: 'opencode_bridge_no_output',
                  severity: 'error',
                  title: 'OpenCode runtime check returned no output',
                  summary: 'OpenCode readiness bridge exited without returning diagnostic JSON.',
                  copyText: 'Agent Teams OpenCode diagnostics\noutputReadError: ENOENT',
                  createdAt: '2026-04-21T12:00:00.000Z',
                },
              ],
            },
            {
              providerId: 'codex',
              status: 'failed',
              details: ['Codex failed'],
              supportDiagnostics: [
                {
                  id: 'diag-codex',
                  providerId: 'codex',
                  kind: 'codex_debug',
                  severity: 'error',
                  title: 'Codex debug',
                  summary: 'Codex debug summary',
                  copyText: 'should not render',
                  createdAt: '2026-04-21T12:00:00.000Z',
                },
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'OpenCode (OpenCode CLI): OpenCode runtime check returned no output'
    );
    expect(host.textContent).toContain('Copy diagnostics');
    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons).toHaveLength(1);

    await act(async () => {
      buttons[0]?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(
      'Agent Teams OpenCode diagnostics\noutputReadError: ENOENT'
    );
    expect(host.textContent).toContain('Copied');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not show copied when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
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
              details: ['OpenCode runtime check returned no output.'],
              supportDiagnostics: [
                {
                  id: 'diag-empty-stdout',
                  providerId: 'opencode',
                  kind: 'opencode_bridge_no_output',
                  severity: 'error',
                  title: 'OpenCode runtime check returned no output',
                  summary: 'OpenCode readiness bridge exited without returning diagnostic JSON.',
                  copyText: 'Agent Teams OpenCode diagnostics',
                  createdAt: '2026-04-21T12:00:00.000Z',
                },
              ],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    const button = host.querySelector('button');
    expect(button?.textContent).toContain('Copy diagnostics');

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Copy diagnostics');
    expect(host.textContent).not.toContain('Copied');

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
    expect(host.textContent).toContain(
      '5.3 Codex - Selected model check failed: Model verification timed out'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('offers provider settings for actionable Codex auth notes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onOpenProviderSettings = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProviderStatusList, {
          checks: [
            {
              providerId: 'codex',
              status: 'notes',
              backendSummary: 'Codex native - auth required',
              details: [
                'Codex native requires OPENAI_API_KEY or CODEX_API_KEY, or a connected ChatGPT account. Add one before launching Codex.',
                'Default - available for launch',
                '5.5 - available for launch',
              ],
            },
            {
              providerId: 'anthropic',
              status: 'notes',
              details: ['Opus 4.6 - available for launch'],
            },
          ],
          onOpenProviderSettings,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Open Codex settings');
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    const button = buttons[0];
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(onOpenProviderSettings).toHaveBeenCalledWith('codex');

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

  it('hides internal OpenCode MCP proof cache markers from preflight details', async () => {
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
              status: 'ready',
              backendSummary: 'OpenCode CLI',
              details: ['opencode_app_mcp_tool_proof_persisted_cache_hit', 'big-pickle - verified'],
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'OpenCode (OpenCode CLI): Selected model checks - 1 verified'
    );
    expect(host.textContent).toContain('big-pickle - Selected model verified');
    expect(host.textContent).not.toContain('opencode_app_mcp_tool_proof_persisted_cache_hit');

    const detailLines = Array.from(host.querySelectorAll('p'));
    expect(detailLines).toHaveLength(1);
    expect(detailLines[0]?.textContent).toBe('big-pickle - Selected model verified');

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
    expect(host.textContent).toContain('nemotron-3-super-free - Selected model verified');

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

  it('keeps direct and external Anthropic routes visible in provisioning summaries', () => {
    const directProvider = {
      providerId: 'anthropic' as const,
      selectedBackendId: null,
      resolvedBackendId: null,
      backend: null,
      availableBackends: [],
    };

    expect(getProvisioningProviderBackendSummary(directProvider)).toBe('Anthropic API');
    expect(
      getProvisioningProviderBackendSummary({
        ...directProvider,
        resolvedBackendId: 'bedrock',
        backend: { kind: 'bedrock', label: 'Amazon Bedrock' },
      })
    ).toBe('Amazon Bedrock');
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
      message: 'All selected providers are ready.',
    });
  });

  it('exposes only terminal successful providers as ready for model selectors', () => {
    expect(
      getProvisioningProviderReadyById([
        { providerId: 'anthropic', status: 'ready', details: [] },
        { providerId: 'codex', status: 'notes', details: ['Ready with notes'] },
        { providerId: 'opencode', status: 'checking', details: [] },
      ])
    ).toEqual({ anthropic: true, codex: true });
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

  it('labels provider-scoped prepare refreshes without implying every provider restarted', () => {
    expect(getProvisioningProviderProgressMessage(['opencode'], 3)).toBe(
      'Checking OpenCode provider...'
    );
    expect(getProvisioningProviderProgressMessage(['anthropic', 'codex'], 3)).toBe(
      'Checking Anthropic, Codex providers...'
    );
    expect(getProvisioningProviderProgressMessage(['anthropic', 'codex', 'opencode'], 3)).toBe(
      'Checking selected providers in parallel...'
    );
  });
});
