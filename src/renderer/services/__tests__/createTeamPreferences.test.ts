import { afterEach, describe, expect, it } from 'vitest';

import {
  applyStoredCreateTeamMemberRuntimePreferences,
  getStoredCreateTeamProvider,
  getStoredCreateTeamMemberRuntimePreferences,
  setStoredCreateTeamMemberRuntimePreferences,
} from '@renderer/services/createTeamPreferences';

describe('createTeamPreferences', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('stores teammate runtime preferences and reapplies them by member name', () => {
    setStoredCreateTeamMemberRuntimePreferences([
      { name: 'alice', providerId: 'codex', model: 'gpt-5', effort: 'high' },
      { name: 'tom' },
    ]);

    const restored = applyStoredCreateTeamMemberRuntimePreferences([
      { name: 'alice', providerId: undefined, model: '', effort: undefined },
      { name: 'tom', providerId: 'anthropic', model: 'opus', effort: 'medium' },
      { name: 'bob', providerId: undefined, model: '', effort: undefined },
    ]);

    expect(getStoredCreateTeamMemberRuntimePreferences()).toEqual([
      { name: 'alice', providerId: 'codex', model: 'gpt-5', effort: 'high' },
      { name: 'tom', providerId: undefined, model: undefined, effort: undefined },
    ]);
    expect(restored).toEqual([
      { name: 'alice', providerId: 'codex', model: 'gpt-5', effort: 'high' },
      { name: 'tom', providerId: undefined, model: '', effort: undefined },
      { name: 'bob', providerId: undefined, model: '', effort: undefined },
    ]);
  });

  it('merges teammate runtime preferences instead of dropping omitted members', () => {
    setStoredCreateTeamMemberRuntimePreferences([
      { name: 'alice', providerId: 'codex', model: 'gpt-5', effort: 'high' },
      { name: 'bob', providerId: 'opencode', model: 'openai/gpt-5.4', effort: 'low' },
    ]);

    setStoredCreateTeamMemberRuntimePreferences([
      { name: 'alice', providerId: 'anthropic', model: 'haiku', effort: 'medium' },
    ]);

    expect(getStoredCreateTeamMemberRuntimePreferences()).toEqual([
      { name: 'alice', providerId: 'anthropic', model: 'haiku', effort: 'medium' },
      { name: 'bob', providerId: 'opencode', model: 'openai/gpt-5.4', effort: 'low' },
    ]);
  });

  it('keeps a stored OpenCode provider selection for future create-team runs', () => {
    localStorage.setItem('createTeam:lastSelectedProvider', 'opencode');

    expect(getStoredCreateTeamProvider()).toBe('opencode');
  });

  it('ignores invalid serialized preferences', () => {
    localStorage.setItem(
      'createTeam:lastMemberRuntimePreferences',
      JSON.stringify({ version: 999, members: [{ name: 'alice', providerId: 'codex' }] })
    );

    expect(getStoredCreateTeamMemberRuntimePreferences()).toEqual([]);
  });
});
