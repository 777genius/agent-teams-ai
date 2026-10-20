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
const legacy = { ...confirmed, effectiveDefaultModel: undefined };
const loading = {
  providerId: 'anthropic',
  supported: false,
  verificationState: 'unknown',
  statusCheckOutcome: 'pending',
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

  it.each([null, loading, legacy])(
    'uses scope-bound confirmed new-contract evidence before global discovery: %j',
    (globalStatus) => {
      expect(resolvePersistedTeamModel({ ...input, globalStatus })).toBe('gateway/project-default');
    }
  );

  it.each([
    null,
    loading,
    { ...legacy, supported: false },
    { ...legacy, verificationState: 'unknown' as const },
    { ...legacy, statusCheckOutcome: 'pending' as const },
    { ...legacy, statusCheckOutcome: 'transient_error' as const },
    { ...legacy, statusCheckOutcome: 'model_only' as const },
    { ...legacy, statusCheckErrorCode: 'unavailable' as const },
    { ...legacy, providerId: 'codex' as const },
  ])('does not infer a legacy contract from unresolved global evidence: %j', (globalStatus) => {
    expect(
      resolvePersistedTeamModel({ ...input, globalStatus, scopedStatus: null })
    ).toBeUndefined();
  });

  it('keeps a scoped new-contract null inherited even if the global snapshot is legacy', () => {
    expect(
      resolvePersistedTeamModel({
        ...input,
        globalStatus: legacy,
        scopedStatus: { ...confirmed, effectiveDefaultModel: null },
      })
    ).toBeUndefined();
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
        globalStatus: loading,
        scopedStatus: null,
      })
    ).toBe('manual-model');
    expect(
      resolvePersistedTeamModel({
        ...input,
        globalStatus: legacy,
        scopedStatus: null,
      })
    ).toBe('catalog-fallback');
    expect(resolvePersistedTeamModel({ ...input, providerId: 'codex', scopedStatus: null })).toBe(
      'catalog-fallback'
    );
    expect(
      resolvePersistedTeamModel({ ...input, providerId: undefined, globalStatus: loading })
    ).toBe('catalog-fallback');
  });
});
