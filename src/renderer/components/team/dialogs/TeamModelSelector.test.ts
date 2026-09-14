import { describe, expect, it } from 'vitest';

import {
  addCodexAstraUpdatePreview,
  resolveTeamModelSelectorValue,
  shouldElevateOpenCodeVirtualRow,
  shouldShowOpenCodeNeedsTestBadge,
  shouldShowOpenCodeOverviewStatus,
} from './teamModelSelectorUi';

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
