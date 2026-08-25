import { describe, expect, it } from 'vitest';

import {
  isProvisioningTeamName,
  parseOptionalLaunchProviderBackendId,
  parseOptionalMemberEffort,
  parseOptionalMemberProviderId,
  parseOptionalProviderBackendId,
  parseOptionalTeamEffort,
  parseOptionalTeamFastMode,
  parseOptionalTeamProviderId,
} from '../../../../src/features/team-configuration';

describe('team runtime selection validation', () => {
  it.each([
    ['demo-team', true],
    ['team1', true],
    ['', false],
    ['Uppercase', false],
    ['bad_team', false],
    ['-leading', false],
    [`a${'b'.repeat(63)}`, true],
    [`a${'b'.repeat(64)}`, false],
  ])('validates provisioning team name %j', (teamName, expected) => {
    expect(isProvisioningTeamName(teamName)).toBe(expected);
  });

  it.each([undefined, null, ''])('normalizes empty provider value %j', (value) => {
    expect(parseOptionalTeamProviderId(value)).toEqual({ valid: true, value: undefined });
    expect(parseOptionalMemberProviderId(value)).toEqual({ valid: true, value: undefined });
  });

  it('preserves exact provider validation errors', () => {
    expect(parseOptionalTeamProviderId('unknown')).toEqual({
      valid: false,
      error: 'providerId must be anthropic, codex, gemini, or opencode',
    });
    expect(parseOptionalMemberProviderId('unknown')).toEqual({
      valid: false,
      error: 'member providerId must be anthropic, codex, gemini, or opencode',
    });
    expect(parseOptionalTeamProviderId('codex')).toEqual({ valid: true, value: 'codex' });
  });

  it('validates and migrates provider-specific backend values', () => {
    expect(parseOptionalProviderBackendId(' codex-native ', 'codex')).toEqual({
      valid: true,
      value: 'codex-native',
    });
    expect(parseOptionalProviderBackendId('auto')).toEqual({ valid: true, value: 'auto' });
    expect(parseOptionalProviderBackendId('opencode-cli', 'codex')).toEqual({
      valid: false,
      error:
        'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)',
    });
    expect(parseOptionalProviderBackendId(42, 'codex')).toEqual({
      valid: false,
      error: 'providerBackendId must be a string',
    });
  });

  it('drops a known stale launch backend while rejecting unknown values', () => {
    expect(parseOptionalLaunchProviderBackendId('codex-native', 'codex')).toEqual({
      valid: true,
      value: 'codex-native',
    });
    expect(parseOptionalLaunchProviderBackendId('codex-native', 'anthropic')).toEqual({
      valid: true,
      value: undefined,
    });
    expect(parseOptionalLaunchProviderBackendId('unknown', 'anthropic')).toEqual({
      valid: false,
      error:
        'providerBackendId must be valid for the selected provider (auto, adapter, api, cli-sdk, codex-native, or opencode-cli)',
    });
  });

  it('validates effort against the selected provider', () => {
    expect(parseOptionalMemberEffort('xhigh', 'codex')).toEqual({ valid: true, value: 'xhigh' });
    expect(parseOptionalTeamEffort('max', 'anthropic')).toEqual({ valid: true, value: 'max' });
    expect(parseOptionalMemberEffort('none', 'codex')).toMatchObject({
      valid: false,
      error: expect.stringContaining('member effort must be one of'),
    });
    expect(parseOptionalTeamEffort('invalid', 'anthropic')).toMatchObject({
      valid: false,
      error: expect.stringContaining('effort must be one of'),
    });
  });

  it.each(['inherit', 'on', 'off'] as const)('accepts fast mode %s', (value) => {
    expect(parseOptionalTeamFastMode(value)).toEqual({ valid: true, value });
  });

  it('normalizes empty fast mode and preserves its exact error', () => {
    expect(parseOptionalTeamFastMode('')).toEqual({ valid: true, value: undefined });
    expect(parseOptionalTeamFastMode('fast')).toEqual({
      valid: false,
      error: 'fastMode must be one of inherit, on, or off',
    });
  });
});
