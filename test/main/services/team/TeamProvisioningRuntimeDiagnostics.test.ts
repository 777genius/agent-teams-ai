import {
  buildRuntimeLaunchWarning,
  getAnthropicFastModeDefault,
  getConfiguredRuntimeBackend,
  getPromptSizeSummary,
  getTeamProviderLabel,
  logRuntimeLaunchSnapshot,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeDiagnostics';
import { describe, expect, it, vi } from 'vitest';

import type { GeminiRuntimeAuthState } from '@main/services/runtime/geminiRuntimeAuth';
import type { ProviderModelLaunchIdentity, TeamProviderId } from '@shared/types';

vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: vi.fn().mockReturnValue({
      getConfig: vi.fn().mockReturnValue({
        providerConnections: {
          anthropic: {
            fastModeDefault: true,
          },
        },
        runtime: {
          providerBackends: {
            codex: 'codex-native',
            gemini: 'cli-sdk',
          },
        },
      }),
    }),
  },
}));

describe('TeamProvisioningRuntimeDiagnostics', () => {
  it('keeps prompt size accounting stable for empty and multiline prompts', () => {
    expect(getPromptSizeSummary('')).toEqual({ chars: 0, lines: 0 });
    expect(getPromptSizeSummary('alpha\r\nbeta\ngamma')).toEqual({
      chars: 'alpha\r\nbeta\ngamma'.length,
      lines: 3,
    });
  });

  it('labels supported team providers without leaking raw ids into diagnostics', () => {
    const labels = new Map<TeamProviderId, string>([
      ['anthropic', 'Anthropic'],
      ['codex', 'Codex'],
      ['gemini', 'Gemini'],
      ['opencode', 'OpenCode'],
    ]);

    for (const [providerId, label] of labels) {
      expect(getTeamProviderLabel(providerId)).toBe(label);
    }
  });

  it('reads configured runtime defaults through a narrow diagnostics adapter', () => {
    expect(getAnthropicFastModeDefault()).toBe(true);
    expect(getConfiguredRuntimeBackend('anthropic')).toBeNull();
    expect(getConfiguredRuntimeBackend('opencode')).toBeNull();
    expect(getConfiguredRuntimeBackend('codex')).toBe('codex-native');
    expect(getConfiguredRuntimeBackend('gemini')).toBe('cli-sdk');
  });

  it('builds Codex launch warnings with explicit backend, prompt and env evidence', () => {
    const warning = buildRuntimeLaunchWarning(
      {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'high',
        fastMode: 'on',
      },
      {
        CLAUDE_CODE_USE_OPENAI: '1',
        CLAUDE_CODE_ENTRY_PROVIDER: 'codex',
        CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
        CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES: '1',
      },
      {
        promptSize: { chars: 12345, lines: 7 },
        expectedMembersCount: 3,
      }
    );

    expect(warning).toContain('Launch runtime: Codex');
    expect(warning).toContain('gpt-5.4');
    expect(warning).toContain('high');
    expect(warning).toContain('fast on');
    expect(warning).toContain('backend codex-native');
    expect(warning).toContain('prompt 12,345 chars/7 lines');
    expect(warning).toContain('members 3');
    expect(warning).toContain(
      'env USE_OPENAI, ENTRY_PROVIDER=codex, CODEX_BACKEND=codex-native, FORCE_PROCESS_TEAMMATES'
    );
  });

  it('includes Gemini auth diagnostics only for Gemini launch warnings', () => {
    const geminiRuntimeAuth: GeminiRuntimeAuthState = {
      authenticated: true,
      authMethod: 'adc_authorized_user',
      resolvedBackend: 'cli-sdk',
      projectId: 'agent-teams-dev',
      statusMessage: null,
    };

    expect(
      buildRuntimeLaunchWarning(
        {
          providerId: 'gemini',
          providerBackendId: 'cli-sdk',
          model: 'gemini-2.5-pro',
          effort: undefined,
          fastMode: undefined,
        },
        {
          CLAUDE_CODE_USE_GEMINI: '1',
          CLAUDE_CODE_GEMINI_BACKEND: 'cli-sdk',
        },
        { geminiRuntimeAuth }
      )
    ).toContain('auth adc_authorized_user/cli-sdk');

    expect(
      buildRuntimeLaunchWarning(
        {
          providerId: 'anthropic',
          providerBackendId: undefined,
          model: undefined,
          effort: undefined,
          fastMode: undefined,
        },
        {},
        { geminiRuntimeAuth }
      )
    ).not.toContain('auth adc_authorized_user/cli-sdk');
  });

  it('logs a structured launch snapshot with nullable env fields and launch identity', () => {
    const messages: string[] = [];
    const launchIdentity: ProviderModelLaunchIdentity = {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      selectedModel: 'gpt-5.4',
      selectedModelKind: 'explicit',
      resolvedLaunchModel: 'gpt-5.4',
      catalogId: null,
      catalogSource: 'runtime',
      catalogFetchedAt: null,
      selectedEffort: 'medium',
      resolvedEffort: 'medium',
      selectedFastMode: 'on',
      resolvedFastMode: true,
      fastResolutionReason: 'explicit',
    };

    logRuntimeLaunchSnapshot(
      { info: (message) => messages.push(message) },
      'atlas',
      '/usr/local/bin/claude',
      ['--model', 'gpt-5.4'],
      {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
        fastMode: 'on',
      },
      { CLAUDE_CODE_USE_OPENAI: '1' },
      {
        promptSize: { chars: 10, lines: 2 },
        expectedMembersCount: 2,
        launchIdentity,
      }
    );

    expect(messages).toHaveLength(1);
    const prefix = '[atlas] Launch runtime snapshot ';
    expect(messages[0]?.startsWith(prefix)).toBe(true);
    const snapshot = JSON.parse(messages[0]!.slice(prefix.length)) as {
      providerId: string;
      providerBackendId: string | null;
      model: string | null;
      effort: string | null;
      fastMode: string | null;
      configuredBackend: string | null;
      promptSize: { chars: number; lines: number } | null;
      expectedMembersCount: number | null;
      launchIdentity: ProviderModelLaunchIdentity | null;
      geminiRuntimeAuth: unknown;
      env: Record<string, string | null>;
      args: string[];
      claudePath: string;
    };

    expect(snapshot).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'medium',
      fastMode: 'on',
      configuredBackend: 'codex-native',
      promptSize: { chars: 10, lines: 2 },
      expectedMembersCount: 2,
      launchIdentity,
      geminiRuntimeAuth: null,
      args: ['--model', 'gpt-5.4'],
      claudePath: '/usr/local/bin/claude',
    });
    expect(snapshot.env.CLAUDE_CODE_USE_OPENAI).toBe('1');
    expect(snapshot.env.CLAUDE_CODE_USE_GEMINI).toBeNull();
    expect(snapshot.env.CLAUDE_CONFIG_DIR).toBeNull();
  });
});
