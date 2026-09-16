import { normalizePersistedTeamLaunchParams } from '@features/team-provisioning/renderer';
import {
  loadAllTeamLaunchParams,
  saveTeamLaunchParams,
} from '@features/team-provisioning/renderer/adapters/createTeamProvisioningLaunchPersistence';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  localStorage.clear();
});

describe('normalizePersistedTeamLaunchParams', () => {
  it('normalizes supported persisted values without retaining unknown fields', () => {
    expect(
      normalizePersistedTeamLaunchParams({
        providerId: 'codex',
        providerBackendId: 'api',
        model: ' gpt-5.6 ',
        effort: 'high',
        fastMode: 'on',
        limitContext: true,
        obsolete: 'ignored',
      })
    ).toEqual({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.6',
      effort: 'high',
      fastMode: 'on',
      limitContext: true,
    });
  });

  it.each([
    null,
    [],
    { providerId: 'unknown' },
    { providerBackendId: 'codex-native' },
    { providerId: 'codex', providerBackendId: 'opencode-cli' },
    { model: '' },
    { effort: 'extreme' },
    { fastMode: true },
    { limitContext: 'yes' },
  ])('rejects malformed persisted values: %j', (value) => {
    expect(normalizePersistedTeamLaunchParams(value)).toBeNull();
  });
});

describe('team launch parameter persistence', () => {
  it('restores only independently valid team entries', () => {
    saveTeamLaunchParams('valid-team', {
      providerId: 'gemini',
      providerBackendId: 'cli-sdk',
      model: 'gemini-3',
      limitContext: false,
    });
    localStorage.setItem('team:launchParams:array-team', '[]');
    localStorage.setItem(
      'team:launchParams:invalid-team',
      JSON.stringify({ providerId: 'codex', effort: 'extreme' })
    );
    localStorage.setItem('team:launchParams:broken-json', '{');

    expect(loadAllTeamLaunchParams()).toEqual({
      'valid-team': {
        providerId: 'gemini',
        providerBackendId: 'cli-sdk',
        model: 'gemini-3',
        limitContext: false,
      },
    });
  });
});
