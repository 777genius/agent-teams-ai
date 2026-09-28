import { describe, expect, it } from 'vitest';

import {
  addCodexAstraUpdatePreview,
  getOpenCodeAuthFilteredModelOptions,
  resolveTeamModelSelectorValue,
  shouldElevateOpenCodeVirtualRow,
  shouldShowOpenCodeNeedsTestBadge,
  shouldShowOpenCodeOverviewStatus,
} from './teamModelSelectorUi';

import type { TeamModelRuntimeProviderStatus } from '@renderer/utils/teamModelAvailability';

describe('OpenCode picker authentication', () => {
  const options = [
    { value: '', label: 'Default' },
    { value: 'opencode/space-bunny-free', label: 'Space Bunny' },
    { value: 'opencode/paid', label: 'Paid Zen' },
    { value: 'openai/gpt-5', label: 'OpenAI' },
    { value: 'ollama/local', label: 'Local' },
  ];
  const status = {
    providerId: 'opencode',
    statusCheckOutcome: 'authoritative',
    modelCatalog: {
      providerId: 'opencode',
      models: [
        {
          id: 'opencode/space-bunny-free',
          launchModel: 'opencode/space-bunny-free',
          metadata: { opencode: { accessKind: 'builtin_free' } },
        },
        {
          id: 'opencode/paid',
          launchModel: 'opencode/paid',
          metadata: {
            opencode: { accessKind: 'not_authenticated', reason: 'Connect OpenCode Zen' },
          },
        },
        {
          id: 'openai/gpt-5',
          launchModel: 'openai/gpt-5',
          metadata: { opencode: { accessKind: 'credentialed' } },
        },
        {
          id: 'ollama/local',
          launchModel: 'ollama/local',
          metadata: { opencode: { accessKind: 'configured_authless' } },
        },
      ],
    },
  } as unknown as TeamModelRuntimeProviderStatus;

  it('shows available free, connected, and local routes while hiding only the route needing auth', () => {
    const result = getOpenCodeAuthFilteredModelOptions({
      options,
      catalogFresh: true,
      providerStatus: status,
      selectedModel: '',
      showAuthRequired: false,
    });
    expect(result.authRequiredCount).toBe(1);
    expect(result.options.map((option) => option.value)).toEqual([
      '',
      'opencode/space-bunny-free',
      'openai/gpt-5',
      'ollama/local',
    ]);
  });

  it('keeps a previously selected auth-required model visible but unavailable', () => {
    const result = getOpenCodeAuthFilteredModelOptions({
      options,
      catalogFresh: true,
      providerStatus: status,
      selectedModel: 'opencode/paid',
      showAuthRequired: false,
    });
    expect(result.options.find((option) => option.value === 'opencode/paid')).toEqual(
      expect.objectContaining({
        availabilityStatus: 'unavailable',
        availabilityReason: 'Connect OpenCode Zen',
      })
    );
  });

  it('shows the paid Zen model after its route becomes credentialed', () => {
    const connectedStatus = {
      ...status,
      modelCatalog: {
        ...status.modelCatalog!,
        models: status.modelCatalog!.models.map((model) => {
          if (model.id !== 'opencode/paid' || !model.metadata?.opencode) return model;
          return {
            ...model,
            metadata: {
              ...model.metadata,
              opencode: { ...model.metadata.opencode, accessKind: 'credentialed' as const },
            },
          };
        }),
      },
    };
    const result = getOpenCodeAuthFilteredModelOptions({
      options,
      catalogFresh: true,
      providerStatus: connectedStatus,
      selectedModel: '',
      showAuthRequired: false,
    });
    expect(result.authRequiredCount).toBe(0);
    expect(result.options.find((option) => option.value === 'opencode/paid')).toEqual(options[2]);
  });

  it('can reveal auth-required models without making them selectable', () => {
    const result = getOpenCodeAuthFilteredModelOptions({
      options,
      catalogFresh: true,
      providerStatus: status,
      selectedModel: '',
      showAuthRequired: true,
    });
    expect(result.options).toHaveLength(options.length);
    expect(
      result.options.find((option) => option.value === 'opencode/paid')?.availabilityStatus
    ).toBe('unavailable');
  });

  it('leaves Default to the project-wide guard when the selected source default needs auth', () => {
    const result = getOpenCodeAuthFilteredModelOptions({
      options,
      catalogFresh: true,
      providerStatus: {
        ...status,
        modelCatalog: { ...status.modelCatalog!, defaultLaunchModel: 'opencode/paid' },
      },
      selectedModel: '',
      showAuthRequired: false,
    });
    expect(result.options[0]).toEqual(options[0]);
  });

  it('does not hide models while auth status is uncertain', () => {
    const result = getOpenCodeAuthFilteredModelOptions({
      options,
      catalogFresh: false,
      providerStatus: { ...status, statusCheckOutcome: 'transient_error' },
      selectedModel: '',
      showAuthRequired: false,
    });
    expect(result.options).toEqual(options);
    expect(result.authRequiredCount).toBe(0);
  });

  it('uses access metadata from a fresh scoped catalog even when passive status is model-only', () => {
    const result = getOpenCodeAuthFilteredModelOptions({
      options,
      catalogFresh: true,
      providerStatus: { ...status, statusCheckOutcome: 'model_only' },
      selectedModel: '',
      showAuthRequired: false,
    });
    expect(result.authRequiredCount).toBe(1);
    expect(result.options.some((option) => option.value === 'opencode/paid')).toBe(false);
    expect(result.options.some((option) => option.value === 'opencode/space-bunny-free')).toBe(
      true
    );
  });

  it('does not trust stale route authentication metadata even with authoritative passive status', () => {
    const result = getOpenCodeAuthFilteredModelOptions({
      options,
      catalogFresh: false,
      providerStatus: status,
      selectedModel: '',
      showAuthRequired: false,
    });
    expect(result.options).toEqual(options);
    expect(result.authRequiredCount).toBe(0);
  });

  it('still hides an unauthenticated route when the runtime omits its reason', () => {
    const result = getOpenCodeAuthFilteredModelOptions({
      options,
      catalogFresh: true,
      providerStatus: {
        ...status,
        modelCatalog: {
          ...status.modelCatalog!,
          models: status.modelCatalog!.models.map((model) =>
            model.id === 'opencode/paid'
              ? {
                  ...model,
                  metadata: { opencode: { accessKind: 'not_authenticated' } },
                }
              : model
          ),
        },
      } as unknown as TeamModelRuntimeProviderStatus,
      selectedModel: '',
      showAuthRequired: false,
    });
    expect(result.options.some((option) => option.value === 'opencode/paid')).toBe(false);
  });
});

const CODEX_RUNTIME_WITH_ASTRA_UPDATE = {
  installed: true,
  version: 'codex-cli 0.152.0',
  latestVersion: '0.153.4',
  updateAvailable: true,
};

describe('addCodexAstraUpdatePreview', () => {
  const defaultOption = { value: '', label: 'Default' };
  const solOption = { value: 'gpt-5.6-sol', label: '5.6 Sol' };

  it('adds an unavailable Astra card after Default for an older updatable Codex runtime', () => {
    expect(
      addCodexAstraUpdatePreview(
        'codex',
        [defaultOption, solOption],
        CODEX_RUNTIME_WITH_ASTRA_UPDATE
      )
    ).toEqual([
      defaultOption,
      expect.objectContaining({
        value: 'gpt-6-astra',
        availabilityStatus: 'unavailable',
        availabilityReason: expect.stringContaining('Update Codex'),
      }),
      solOption,
    ]);
  });

  it('marks live-catalog Astra as update-required without adding a duplicate', () => {
    const astraOption = { value: 'gpt-6-astra', label: 'GPT-6 Astra' };
    expect(
      addCodexAstraUpdatePreview(
        'codex',
        [defaultOption, astraOption],
        CODEX_RUNTIME_WITH_ASTRA_UPDATE
      )
    ).toEqual([
      defaultOption,
      expect.objectContaining({
        ...astraOption,
        availabilityStatus: 'unavailable',
        availabilityReason: expect.stringContaining('Update Codex'),
      }),
    ]);
  });

  it('does not advertise Astra when the available update cannot provide it', () => {
    expect(
      addCodexAstraUpdatePreview('codex', [defaultOption, solOption], {
        ...CODEX_RUNTIME_WITH_ASTRA_UPDATE,
        latestVersion: '0.153.3',
      })
    ).toEqual([defaultOption, solOption]);
  });

  it('does not add the update preview once the installed runtime supports Astra', () => {
    expect(
      addCodexAstraUpdatePreview('codex', [defaultOption, solOption], {
        ...CODEX_RUNTIME_WITH_ASTRA_UPDATE,
        version: 'codex-cli 0.153.4',
      })
    ).toEqual([defaultOption, solOption]);
  });
});

describe('resolveTeamModelSelectorValue', () => {
  it('preserves an explicit local OpenCode route outside the current catalog and overlay', () => {
    expect(
      resolveTeamModelSelectorValue({
        providerId: 'opencode',
        value: 'ollama/qwen3-coder:30b',
        runtimeNormalizedValue: '',
        isAppManagedLocalModel: true,
        isInLocalOverlay: false,
        isLocalLookupAuthoritative: true,
      })
    ).toBe('ollama/qwen3-coder:30b');
  });

  it('uses runtime normalization for non-local catalog selections', () => {
    expect(
      resolveTeamModelSelectorValue({
        providerId: 'opencode',
        value: 'missing/model',
        runtimeNormalizedValue: '',
        isAppManagedLocalModel: false,
        isInLocalOverlay: false,
        isLocalLookupAuthoritative: true,
      })
    ).toBe('');
  });

  it('keeps an explicitly selected Copilot model visible even when the catalog rejects it', () => {
    expect(
      resolveTeamModelSelectorValue({
        providerId: 'opencode',
        value: 'github-copilot/gpt-5-mini',
        runtimeNormalizedValue: '',
        preserveSelectedModel: true,
        isAppManagedLocalModel: false,
        isInLocalOverlay: false,
        isLocalLookupAuthoritative: true,
      })
    ).toBe('github-copilot/gpt-5-mini');
  });

  it('preserves a qualified OpenCode selection while local lookup is not authoritative', () => {
    expect(
      resolveTeamModelSelectorValue({
        providerId: 'opencode',
        value: 'local-lab/team-model',
        runtimeNormalizedValue: '',
        isAppManagedLocalModel: false,
        isInLocalOverlay: false,
        isLocalLookupAuthoritative: false,
      })
    ).toBe('local-lab/team-model');
  });
});

describe('shouldShowOpenCodeNeedsTestBadge', () => {
  it('hides the needs-test badge for Cursor ACP, whose connection flow verifies the model', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('needs_probe', 'cursor-acp')).toBe(false);
  });

  it('keeps the needs-test badge for an unverified Kiro model', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('needs_probe', 'kiro')).toBe(true);
  });

  it('keeps the needs-test badge for other OpenCode sources', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('needs_probe', 'opencode-config')).toBe(true);
  });

  it('does not show a misleading per-model badge for a live configured local server', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('needs_probe', 'ollama', 'configured_local')).toBe(
      false
    );
  });

  it('does not show the badge for other proof states', () => {
    expect(shouldShowOpenCodeNeedsTestBadge('verified', 'cursor-acp')).toBe(false);
  });
});

describe('shouldElevateOpenCodeVirtualRow', () => {
  it('keeps the active heading below its sticky copy', () => {
    expect(shouldElevateOpenCodeVirtualRow('heading', 4, 4)).toBe(false);
  });

  it('raises an incoming heading above the previous sticky heading', () => {
    expect(shouldElevateOpenCodeVirtualRow('heading', 8, 4)).toBe(true);
  });

  it('never raises model rows', () => {
    expect(shouldElevateOpenCodeVirtualRow('models', 5, 4)).toBe(false);
  });
});

describe('shouldShowOpenCodeOverviewStatus', () => {
  it('shows overview guidance only on the unfiltered OpenCode tab', () => {
    expect(shouldShowOpenCodeOverviewStatus('opencode', 0, 0)).toBe(true);
    expect(shouldShowOpenCodeOverviewStatus('opencode', 1, 0)).toBe(false);
    expect(shouldShowOpenCodeOverviewStatus('opencode', 0, 1)).toBe(false);
    expect(shouldShowOpenCodeOverviewStatus('anthropic', 0, 0)).toBe(false);
  });
});
