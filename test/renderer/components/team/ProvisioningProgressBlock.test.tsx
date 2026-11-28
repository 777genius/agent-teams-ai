import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  openExternal: vi.fn(),
  getLaunchFailureDiagnostics: vi.fn(),
  stepperProps: [] as { active?: boolean }[],
}));

vi.mock('@renderer/api', () => ({
  api: {
    openExternal: hoisted.openExternal,
    teams: { getLaunchFailureDiagnostics: hoisted.getLaunchFailureDiagnostics },
  },
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => React.createElement('button', { type: 'button', ...props }, children),
}));

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => React.createElement('div', null, content),
}));

vi.mock('@renderer/components/team/CliLogsRichView', () => ({
  CliLogsRichView: ({ cliLogsTail }: { cliLogsTail: string }) =>
    React.createElement('div', null, `logs:${cliLogsTail}`),
}));

vi.mock('@renderer/components/team/StepProgressBar', () => ({
  StepProgressBar: (props: { active?: boolean }) => {
    hoisted.stepperProps.push(props);
    return React.createElement(
      'div',
      { 'data-stepper-active': props.active ? 'true' : 'false' },
      'step-progress'
    );
  },
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    AlertTriangle: Icon,
    Check: Icon,
    CheckCircle2: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    ClipboardList: Icon,
    Info: Icon,
    Loader2: Icon,
    X: Icon,
  };
});

import { formatLaunchFailureArtifactCopy } from '@renderer/components/team/provisioningLaunchDiagnosticsCopy';
import { ProvisioningProgressBlock } from '@renderer/components/team/ProvisioningProgressBlock';

import { hostTeamRunId } from '../../../../src/features/agent-backend/contracts/teamRunSelection';
import { hostTeamSelectionKey } from '../../../../src/features/agent-backend/contracts/teamSelection';
import { createHostTeamsApi } from '../../../../src/features/agent-backend/renderer/createHostTeamsApi';

import type { BackendLaunchConfigurationView } from '../../../../src/features/agent-backend/contracts/launch';
import type { AgentBackendApi } from '../../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '@shared/types/api';

describe('ProvisioningProgressBlock', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    hoisted.openExternal.mockReset();
    hoisted.getLaunchFailureDiagnostics.mockReset();
    hoisted.stepperProps = [];
    vi.unstubAllGlobals();
  });

  it('keeps live output and CLI logs collapsed by default while launch is still running', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Launching team',
          currentStepIndex: 1,
          loading: true,
          startedAt: '2026-04-20T12:00:00.000Z',
          pid: 1234,
          assistantOutput: 'streamed output',
          cliLogsTail: 'tail line',
          defaultLiveOutputOpen: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Live output');
    expect(host.textContent).toContain('CLI logs');
    expect(host.textContent).not.toContain('streamed output');
    expect(host.textContent).not.toContain('logs:tail line');
    expect(host.querySelector('[data-stepper-active]')?.getAttribute('data-stepper-active')).toBe(
      'true'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders non-fatal provisioning warnings in the progress panel', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Launching team',
          currentStepIndex: 1,
          loading: true,
          warnings: ['Large Codex team launch: 9 primary teammates will bootstrap in one runtime.'],
          defaultLiveOutputOpen: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Large Codex team launch');
    expect(host.textContent).toContain('9 primary teammates');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders bounded launch diagnostics without opening CLI logs', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Launching team',
          currentStepIndex: 2,
          loading: true,
          defaultLiveOutputOpen: false,
          cliLogsTail: 'tail line',
          launchDiagnostics: [
            {
              id: 'bob:tmux_shell_only',
              memberName: 'bob',
              severity: 'warning',
              code: 'tmux_shell_only',
              label: 'bob - shell only',
              detail: 'tmux pane foreground command is zsh',
              observedAt: '2026-04-24T12:00:00.000Z',
            },
            {
              id: 'tom:runtime_not_found',
              memberName: 'tom',
              severity: 'warning',
              code: 'runtime_not_found',
              label: 'tom - waiting for runtime',
              detail: 'registered runtime metadata without live process',
              observedAt: '2026-04-24T12:00:01.000Z',
            },
            {
              id: 'jack:process_table_unavailable',
              memberName: 'jack',
              severity: 'warning',
              code: 'process_table_unavailable',
              label: 'jack - process table unavailable',
              detail: 'runtime pid could not be verified because process table is unavailable',
              observedAt: '2026-04-24T12:00:02.000Z',
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Diagnostics');
    expect(host.textContent).not.toContain('logs:tail line');

    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Diagnostics')
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('bob - shell only');
    expect(host.textContent).toContain('tmux pane foreground command is zsh');
    expect(host.textContent).toContain('tom - waiting for runtime');
    expect(host.textContent).toContain('registered runtime metadata without live process');
    expect(host.textContent).toContain('jack - process table unavailable');
    expect(host.textContent).toContain(
      'runtime pid could not be verified because process table is unavailable'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('hides launch diagnostics when all entries are informational', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Launching team',
          currentStepIndex: 2,
          loading: true,
          defaultLiveOutputOpen: false,
          launchDiagnostics: [
            {
              id: 'alice:bootstrap_confirmed',
              memberName: 'alice',
              severity: 'info',
              code: 'bootstrap_confirmed',
              label: 'alice - bootstrap confirmed',
              observedAt: '2026-04-24T12:00:00.000Z',
            },
          ],
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Diagnostics');
    expect(host.textContent).not.toContain('alice - bootstrap confirmed');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('copies a combined diagnostics payload from the live output toolbar', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Launching team',
          message: 'Starting agent runtime process',
          currentStepIndex: 1,
          loading: true,
          defaultLiveOutputOpen: true,
          startedAt: '2026-04-28T12:00:00.000Z',
          pid: 321,
          assistantOutput: 'Launch trace line Authorization: Bearer assistant-token',
          cliLogsTail:
            '[stderr] OPENAI_API_KEY=secret-value ANTHROPIC_AUTH_TOKEN="local token"\n[stdout] booted',
          warnings: ['Large Codex team launch: 9 primary teammates will bootstrap in one runtime.'],
          launchDiagnostics: [
            {
              id: 'alice:runtime_not_found',
              memberName: 'alice',
              severity: 'warning',
              code: 'runtime_not_found',
              label: 'alice - waiting for runtime',
              detail: 'codex --api-key hidden-value',
              observedAt: '2026-04-28T12:00:01.000Z',
            },
          ],
        })
      );
      await Promise.resolve();
    });

    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Copy diagnostics')
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = String(writeText.mock.calls[0]?.[0] ?? '');
    expect(copied).toContain('# Team provisioning diagnostics');
    expect(copied).toContain('## Quick triage');
    expect(copied).toContain('Title: Launching team');
    expect(copied).toContain('Message: Starting agent runtime process');
    expect(copied).toContain('PID: 321');
    expect(copied).toContain(
      'Counts: warnings=1; launchDiagnostics=1; memberSnapshots=0; artifactFiles=0'
    );
    expect(copied).toContain('Large-team signal: Large Codex team launch');
    expect(copied).toContain('## Warnings');
    expect(copied).toContain('- Large Codex team launch');
    expect(copied).toContain('alice - waiting for runtime');
    expect(copied).toContain('<summary>Live output</summary>');
    expect(copied).toContain('<summary>CLI logs tail</summary>');
    expect(copied).toContain('Launch trace line');
    expect(copied).toContain('[stdout] booted');
    expect(copied).toContain('OPENAI_API_KEY=[redacted]');
    expect(copied).toContain('ANTHROPIC_AUTH_TOKEN=[redacted]');
    expect(copied).toContain('Authorization: Bearer [redacted]');
    expect(copied).toContain('--api-key [redacted]');
    expect(copied).not.toContain('secret-value');
    expect(copied).not.toContain('local token');
    expect(copied).not.toContain('assistant-token');
    expect(copied).not.toContain('hidden-value');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it.each([false, true])(
    'copies original Host evidence through the actual API route (partial=%s)',
    async (partial) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      const configuration: BackendLaunchConfigurationView = {
        launch: {
          launchId: 'failed-run',
          rosterRevision: 'captured-roster',
          startedAtMs: 1000,
          observedAtMs: 2000,
          status: 'failed',
          ready: 0,
          expected: 1,
          retryCapability: 'same-binding-no-allocation-only',
          members: [
            {
              memberId: 'lead',
              generation: 'captured-generation',
              attemptId: 'initial',
              status: 'failed',
              nativeReady: false,
              usable: false,
              controlAvailable: true,
              noAllocation: false,
              reason: 'bootstrap-timeout',
            },
          ],
        },
        members: [{ memberId: 'lead', label: 'Lead', role: 'lead', selected: null }],
      };
      const backend: AgentBackendApi = {
        getConnections: vi.fn<AgentBackendApi['getConnections']>(async () => ({
          state: 'ready',
          bindings: [{ handle: { handleId: 'copy-owner' }, label: 'Team', members: [] }],
        })),
        invoke: vi.fn<AgentBackendApi['invoke']>(async (request) => {
          if (request.operation === 'team.launch.configuration.read')
            return { ok: true, value: structuredClone(configuration) };
          if (request.operation === 'runtime.read')
            return partial
              ? { ok: false, code: 'hold', outcome: 'unknown' }
              : {
                  ok: true,
                  value: {
                    memberId: 'lead',
                    generation: 'captured-generation',
                    phase: 'open-unknown',
                    sealed: false,
                    custody: 'unknown',
                    nativeReady: false,
                    attached: false,
                    inputs: [],
                    interactions: [],
                    diagnostic: 'Readiness unavailable OPENAI_API_KEY=TEST-private-key',
                  },
                };
          throw new Error('Unexpected operation');
        }),
      };
      const legacy = { getLaunchFailureDiagnostics: vi.fn() } as unknown as TeamsAPI;
      const teams = createHostTeamsApi(legacy, backend, () => () => true);
      hoisted.getLaunchFailureDiagnostics.mockImplementation(teams.getLaunchFailureDiagnostics);
      const teamName = hostTeamSelectionKey('copy-owner');
      const runId = hostTeamRunId('copy-owner', 'failed-run', 'captured-roster');
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(
          React.createElement(ProvisioningProgressBlock, {
            title: 'Launch failed',
            teamName,
            runId,
            tone: 'error',
            currentStepIndex: -1,
            loading: false,
            defaultLiveOutputOpen: false,
          })
        );
      });
      const button = host.querySelector('[aria-label="Copy diagnostics"]');
      expect(button).toBeTruthy();
      await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(writeText).toHaveBeenCalledTimes(1);
      const copied = String(writeText.mock.calls[0][0]);
      expect(hoisted.getLaunchFailureDiagnostics).toHaveBeenCalledWith(teamName, runId);
      expect(copied).toContain('source: captured-host (read-only launch/runtime observations)');
      expect(copied).toContain(`status: ${partial ? 'partial' : 'observed'}`);
      expect(copied).toContain('"reason": "bootstrap-timeout"');
      expect(copied).toContain('"generation": "captured-generation"');
      expect(copied).toContain(partial ? 'issue: hold (unknown)' : 'Readiness unavailable');
      expect(copied).not.toContain('TEST-private-key');
      expect(copied).not.toContain('latestPath:');
      expect(copied).not.toContain('This operation is not supported for Host teams');
      expect(legacy.getLaunchFailureDiagnostics).not.toHaveBeenCalled();
      expect(vi.mocked(backend.invoke).mock.calls.map(([r]) => r.operation)).toEqual([
        'team.launch.configuration.read',
        'runtime.read',
        'team.launch.configuration.read',
      ]);
      await act(async () => {
        root.unmount();
      });
    }
  );

  it('preserves the existing legacy artifact copy format', () => {
    expect(
      formatLaunchFailureArtifactCopy({
        teamName: 'legacy-team',
        runId: 'legacy-run',
        latestPath: '/TEST/latest.json',
        artifactDirectory: '/TEST/run',
        manifestPath: '/TEST/run/manifest.json',
        classification: { code: 'timeout', confidence: 0.5 },
        bootstrapTransportBreadcrumb: { bootstrapSubmitted: false },
        files: [
          { label: 'Manifest', path: '/TEST/run/manifest.json', content: '  manifest contents\n' },
          { label: 'Logs', path: '/TEST/run/logs.txt', issue: 'unavailable' },
        ],
      })
    ).toBe(
      [
        'teamName: legacy-team',
        'runId: legacy-run',
        'latestPath: /TEST/latest.json',
        'artifactDirectory: /TEST/run',
        'manifestPath: /TEST/run/manifest.json',
        '',
        'classification:',
        '{\n  "code": "timeout",\n  "confidence": 0.5\n}',
        '',
        'bootstrapTransportBreadcrumb:',
        '{\n  "bootstrapSubmitted": false\n}',
        '',
        'files:',
        '',
        '--- Manifest',
        'path: /TEST/run/manifest.json',
        'issue: (none)',
        'content:',
        'manifest contents',
        '',
        '--- Logs',
        'path: /TEST/run/logs.txt',
        'issue: unavailable',
        'content:',
        '(empty)',
      ].join('\n')
    );
  });

  it('emphasizes the copy diagnostics CTA when launch has failed', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Workspace trust required',
          message: 'Claude workspace trust was not confirmed',
          tone: 'error',
          messageSeverity: 'error',
          currentStepIndex: -1,
          loading: false,
          defaultLiveOutputOpen: false,
        })
      );
      await Promise.resolve();
    });

    const button = host.querySelector('[aria-label="Copy diagnostics"]');
    expect(button).toBeTruthy();
    expect(button?.className).toContain('h-8');
    expect(button?.className).toContain('border-red-500/60');
    expect(button?.className).toContain('bg-red-500/15');
    expect(button?.className).toContain('animate-pulse');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders multi-line status messages and opens links externally', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProgressBlock, {
          title: 'Launch details',
          message:
            'Failed teammates:\n- alice - Insufficient credits. Add more using https://openrouter.ai/settings/credits\n- tom - Insufficient credits. Add more using https://openrouter.ai/settings/credits',
          messageSeverity: 'warning',
          currentStepIndex: 2,
          loading: false,
          defaultLiveOutputOpen: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Failed teammates:');
    expect(host.textContent).toContain('alice - Insufficient credits');
    expect(host.textContent).toContain('tom - Insufficient credits');
    expect(host.querySelector('[data-stepper-active]')?.getAttribute('data-stepper-active')).toBe(
      'false'
    );

    const links = host.querySelectorAll('a[href="https://openrouter.ai/settings/credits"]');
    expect(links).toHaveLength(2);

    await act(async () => {
      links[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(hoisted.openExternal).toHaveBeenCalledWith('https://openrouter.ai/settings/credits');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
