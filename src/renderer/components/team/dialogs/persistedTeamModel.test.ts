import { describe, expect, it } from 'vitest';

import { resolvePersistedTeamModel } from './persistedTeamModel';

import type { CliProviderStatus } from '@shared/types';

const confirmed = {
  providerId: 'anthropic',
  supported: true,
  verificationState: 'verified',
  statusCheckOutcome: 'authoritative',
  effectiveDefaultModel: 'gateway/project-default',
} as CliProviderStatus;
const input = {
  model: 'catalog-fallback',
  selectedModel: '',
  providerId: 'anthropic' as const,
  globalStatus: { ...confirmed, effectiveDefaultModel: null },
  scopedStatus: confirmed,
  projectSelectionReady: true,
  probedCwd: '/fixture/project',
  persistedCwd: '/fixture/project',
  limitContext: false,
};

describe('persisting a provider Default selection', () => {
  it('pins only the confirmed project default, including the existing context policy', () => {
    expect(resolvePersistedTeamModel(input)).toBe('gateway/project-default');
    expect(
      resolvePersistedTeamModel({
        ...input,
        scopedStatus: { ...confirmed, effectiveDefaultModel: 'claude-opus-5[1m]' },
        limitContext: true,
      })
    ).toBe('claude-opus-5');
  });

  it.each([
    { projectSelectionReady: false },
    { scopedStatus: null },
    { scopedStatus: { ...confirmed, effectiveDefaultModel: null } },
    { scopedStatus: { ...confirmed, statusCheckOutcome: 'pending' as const } },
    { scopedStatus: { ...confirmed, statusCheckOutcome: 'transient_error' as const } },
    { persistedCwd: undefined },
    { persistedCwd: '/fixture/other-project' },
  ])('keeps the new inherited selection unresolved for %j', (overrides) => {
    expect(resolvePersistedTeamModel({ ...input, ...overrides })).toBeUndefined();
  });

  it('preserves explicit models and the old absent-field contract without scoped authority', () => {
    expect(
      resolvePersistedTeamModel({
        ...input,
        model: 'manual-model',
        selectedModel: 'manual-model',
        scopedStatus: null,
      })
    ).toBe('manual-model');
    expect(
      resolvePersistedTeamModel({
        ...input,
        globalStatus: { ...confirmed, effectiveDefaultModel: undefined },
        scopedStatus: null,
      })
    ).toBe('catalog-fallback');
    expect(resolvePersistedTeamModel({ ...input, providerId: 'codex', scopedStatus: null })).toBe(
      'catalog-fallback'
    );
  });
});
