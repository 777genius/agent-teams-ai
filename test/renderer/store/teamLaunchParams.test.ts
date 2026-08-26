import { describe, expect, it } from 'vitest';

import {
  applyLeadRuntimeSettingsToLaunchParams,
  areTeamLaunchParamsEqual,
  buildLaunchParamsFromRuntimeRequest,
  extractBaseModel,
  parseStoredTeamLaunchParams,
  saveTeamLaunchParams,
} from '../../../src/renderer/store/team/teamLaunchParams';

import type { TeamLaunchParams } from '../../../src/renderer/store/team/teamLaunchParams';

const codexFallback: TeamLaunchParams = {
  providerId: 'codex',
  providerBackendId: 'codex-native',
  model: 'gpt-5.5',
  effort: 'medium',
  fastMode: 'on',
  limitContext: true,
};

describe('teamLaunchParams', () => {
  it('extracts provider-scoped base models', () => {
    expect(extractBaseModel(' opus[1m] ', 'anthropic')).toBe('opus');
    expect(extractBaseModel('sonnet', 'anthropic')).toBe('sonnet');
    expect(extractBaseModel('gpt-5.5[1m]', 'codex')).toBe('gpt-5.5[1m]');
    expect(extractBaseModel('   ', 'anthropic')).toBeUndefined();
    expect(extractBaseModel(undefined, 'anthropic')).toBeUndefined();
  });

  it('builds default anthropic launch params without fallback', () => {
    expect(buildLaunchParamsFromRuntimeRequest({})).toEqual({
      providerId: 'anthropic',
      providerBackendId: undefined,
      model: 'default',
      effort: undefined,
      fastMode: undefined,
      limitContext: false,
    });
  });

  it('preserves fallback values for metadata-only requests on the same provider', () => {
    expect(buildLaunchParamsFromRuntimeRequest({}, codexFallback)).toEqual(codexFallback);
  });

  it('resets provider-scoped values when the provider changes without explicit fields', () => {
    expect(
      buildLaunchParamsFromRuntimeRequest(
        {
          providerId: 'anthropic',
        },
        codexFallback
      )
    ).toEqual({
      providerId: 'anthropic',
      providerBackendId: undefined,
      model: 'default',
      effort: undefined,
      fastMode: undefined,
      limitContext: false,
    });
  });

  it('uses explicit model, effort, fast mode, and limitContext when present', () => {
    expect(
      buildLaunchParamsFromRuntimeRequest(
        {
          providerId: 'anthropic',
          model: 'haiku[1m]',
          effort: 'low',
          fastMode: 'off',
          limitContext: false,
        },
        codexFallback
      )
    ).toEqual({
      providerId: 'anthropic',
      providerBackendId: undefined,
      model: 'haiku',
      effort: 'low',
      fastMode: 'off',
      limitContext: false,
    });
  });

  it('treats an explicit undefined model as Default for the active provider', () => {
    expect(
      buildLaunchParamsFromRuntimeRequest(
        {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: undefined,
          effort: 'low',
        },
        codexFallback
      )
    ).toEqual({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'default',
      effort: 'low',
      fastMode: 'on',
      limitContext: true,
    });
  });

  it.each(['api', 'adapter', 'auto', 'codex-native'] as const)(
    'preserves live/current Codex backend %s while building launch params',
    (providerBackendId) => {
      expect(
        buildLaunchParamsFromRuntimeRequest({
          providerId: 'codex',
          providerBackendId,
        })
      ).toEqual({
        providerId: 'codex',
        providerBackendId,
        model: 'default',
        effort: undefined,
        fastMode: undefined,
        limitContext: false,
      });
    }
  );

  it('compares launch params by all persisted fields', () => {
    expect(areTeamLaunchParamsEqual(codexFallback, { ...codexFallback })).toBe(true);
    expect(
      areTeamLaunchParamsEqual(codexFallback, {
        ...codexFallback,
        fastMode: 'off',
      })
    ).toBe(false);
    expect(areTeamLaunchParamsEqual(undefined, undefined)).toBe(true);
    expect(areTeamLaunchParamsEqual(undefined, codexFallback)).toBe(false);
  });

  it('updates only lead model and effort while preserving unrelated launch settings', () => {
    expect(
      applyLeadRuntimeSettingsToLaunchParams(codexFallback, {
        model: 'gpt-5.6-sol',
        effort: 'high',
      })
    ).toEqual({
      ...codexFallback,
      model: 'gpt-5.6-sol',
      effort: 'high',
      leadRuntimeSelectionProvenance: {
        version: 1,
        providerBackendId: 'default',
        model: 'explicit',
        effort: 'explicit',
      },
    });
  });

  it('does not synthesize an incomplete override without existing launch params', () => {
    expect(
      applyLeadRuntimeSettingsToLaunchParams(undefined, {
        model: 'gpt-5.6-sol',
        effort: 'medium',
      })
    ).toBeUndefined();
  });

  it('distinguishes historical unversioned storage from current versioned storage', () => {
    expect(
      parseStoredTeamLaunchParams(JSON.stringify({ providerId: 'codex', providerBackendId: 'api' }))
    ).toMatchObject({ providerBackendId: 'codex-native' });
    expect(
      parseStoredTeamLaunchParams(
        JSON.stringify({
          version: 1,
          params: { providerId: 'codex', providerBackendId: 'api' },
        })
      )
    ).toMatchObject({ providerBackendId: 'api' });
    expect(
      parseStoredTeamLaunchParams(JSON.stringify({ version: 1, params: { providerId: 'codex' } }))
    ).toMatchObject({ providerId: 'codex', providerBackendId: undefined });
    expect(parseStoredTeamLaunchParams(JSON.stringify({ providerId: 'codex' }))).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
    });
  });

  it.each([
    { providerId: 'codex', model: 42 },
    { providerId: 'unknown' },
    { providerId: 'gemini', providerBackendId: 'codex-native' },
    { providerId: 'codex', effort: 'impossible' },
    { providerId: 'codex', fastMode: true },
    { providerId: 'codex', limitContext: 'yes' },
    { providerId: 'codex', unexpected: 'field' },
  ])('rejects corrupt current-version params without throwing: %j', (params) => {
    expect(parseStoredTeamLaunchParams(JSON.stringify({ version: 1, params }))).toBeNull();
  });

  it.each([
    '{not-json',
    JSON.stringify({ version: 1, params: {}, unexpected: true }),
    JSON.stringify({ version: 2, params: {} }),
    JSON.stringify({ version: { future: true }, params: {} }),
  ])('rejects malformed or unknown envelope shape without throwing', (raw) => {
    expect(() => parseStoredTeamLaunchParams(raw)).not.toThrow();
    expect(parseStoredTeamLaunchParams(raw)).toBeNull();
  });

  it('conservatively ignores corrupt historical fields during unversioned migration', () => {
    expect(
      parseStoredTeamLaunchParams(
        JSON.stringify({
          providerId: 'codex',
          providerBackendId: 42,
          model: 42,
          effort: 'impossible',
          fastMode: false,
          limitContext: 'yes',
          historicalExtra: true,
        })
      )
    ).toEqual({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: undefined,
      effort: undefined,
      fastMode: undefined,
      limitContext: undefined,
    });
  });

  it('persists current launch params in a versioned provenance envelope', () => {
    saveTeamLaunchParams('versioned-team', {
      providerId: 'codex',
      providerBackendId: 'adapter',
    });
    expect(JSON.parse(localStorage.getItem('team:launchParams:versioned-team') ?? '{}')).toEqual({
      version: 1,
      params: { providerId: 'codex', providerBackendId: 'adapter' },
    });
    localStorage.removeItem('team:launchParams:versioned-team');
  });
});
