import { describe, expect, it } from 'vitest';

import {
  areTeamLaunchParamsEqual,
  buildLaunchParamsFromRuntimeRequest,
  extractBaseModel,
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

  it('migrates legacy provider backend ids for codex requests', () => {
    expect(
      buildLaunchParamsFromRuntimeRequest({
        providerId: 'codex',
        providerBackendId: 'api',
      })
    ).toEqual({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'default',
      effort: undefined,
      fastMode: undefined,
      limitContext: false,
    });
  });

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
});
