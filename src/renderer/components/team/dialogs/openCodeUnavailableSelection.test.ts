import { describe, expect, it } from 'vitest';

import {
  buildSelectedOpenCodeFallbackOption,
  buildUnavailableOpenCodeSelectionOption,
  shouldKeepUnavailableOpenCodeSelection,
} from './openCodeUnavailableSelection';

const base = {
  value: 'opencode-go/space-bunny-free',
  runtimeNormalizedValue: '',
  catalogSourceProviderId: 'opencode-go',
  catalogStatus: 'ready' as const,
  catalogState: 'fresh' as const,
  isLocalModel: false,
  disabledReason: null,
};

describe('shouldKeepUnavailableOpenCodeSelection', () => {
  it('keeps a route that its own fresh catalog does not offer', () => {
    expect(shouldKeepUnavailableOpenCodeSelection(base)).toBe(true);
    expect(
      shouldKeepUnavailableOpenCodeSelection({ ...base, catalogSourceProviderId: 'OpenCode-Go' })
    ).toBe(true);
  });

  it('leaves Default and unqualified values to the normal normalization', () => {
    expect(shouldKeepUnavailableOpenCodeSelection({ ...base, value: '' })).toBe(false);
    expect(shouldKeepUnavailableOpenCodeSelection({ ...base, value: 'big-pickle' })).toBe(false);
  });

  it('does not interfere when the route is available', () => {
    expect(
      shouldKeepUnavailableOpenCodeSelection({ ...base, runtimeNormalizedValue: base.value })
    ).toBe(false);
  });

  it('still clears when the loaded catalog belongs to another source the user switched to', () => {
    expect(
      shouldKeepUnavailableOpenCodeSelection({ ...base, catalogSourceProviderId: 'opencode' })
    ).toBe(false);
    expect(shouldKeepUnavailableOpenCodeSelection({ ...base, catalogSourceProviderId: null })).toBe(
      false
    );
  });

  it('does not decide on a catalog that is not fresh and ready', () => {
    expect(shouldKeepUnavailableOpenCodeSelection({ ...base, catalogStatus: 'loading' })).toBe(
      false
    );
    expect(shouldKeepUnavailableOpenCodeSelection({ ...base, catalogStatus: 'error' })).toBe(false);
    expect(shouldKeepUnavailableOpenCodeSelection({ ...base, catalogState: 'stale' })).toBe(false);
  });

  it('leaves local models and policy-disabled models to their existing handling', () => {
    expect(shouldKeepUnavailableOpenCodeSelection({ ...base, isLocalModel: true })).toBe(false);
    expect(
      shouldKeepUnavailableOpenCodeSelection({ ...base, disabledReason: 'Temporarily disabled.' })
    ).toBe(false);
  });
});

describe('buildUnavailableOpenCodeSelectionOption', () => {
  it('builds an unavailable option that keeps the exact route and the reason', () => {
    const option = buildUnavailableOpenCodeSelectionOption(' opencode-go/space-bunny-free ', 'why');
    expect(option).toMatchObject({
      value: 'opencode-go/space-bunny-free',
      label: 'space-bunny-free',
      availabilityStatus: 'unavailable',
      availabilityReason: 'why',
    });
  });
});

describe('buildSelectedOpenCodeFallbackOption', () => {
  const base = {
    value: 'opencode-go/space-bunny-free',
    keepUnavailable: true,
    unavailableReason: 'generic',
    selectedUnverifiedLocalModel: false,
    localProvidersLoading: false,
    localProviderLookupError: null,
  };

  it("shows the catalog's own reason for the kept route when it has one", () => {
    const option = buildSelectedOpenCodeFallbackOption({
      ...base,
      catalogStatus: {
        modelAvailability: [
          {
            modelId: 'opencode-go/space-bunny-free',
            status: 'unavailable',
            reason: 'Connect OpenCode Go first',
            checkedAt: null,
          },
        ],
      },
    });
    expect(option?.availabilityReason).toBe('Connect OpenCode Go first');
  });

  it('falls back to the generic reason when the catalog gives none', () => {
    expect(buildSelectedOpenCodeFallbackOption(base)?.availabilityReason).toBe('generic');
  });
});
