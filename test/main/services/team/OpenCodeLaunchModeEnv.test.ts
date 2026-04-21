import { describe, expect, it } from 'vitest';

import { resolveOpenCodeTeamLaunchModeFromEnv } from '../../../../src/main/services/team/opencode/config/OpenCodeLaunchModeEnv';

describe('resolveOpenCodeTeamLaunchModeFromEnv', () => {
  it('defaults to production so OpenCode is visible while strict readiness remains authoritative', () => {
    expect(resolveOpenCodeTeamLaunchModeFromEnv({})).toBe('production');
  });

  it('preserves explicit launch mode overrides', () => {
    expect(
      resolveOpenCodeTeamLaunchModeFromEnv({ CLAUDE_TEAM_OPENCODE_LAUNCH_MODE: 'disabled' })
    ).toBe('disabled');
    expect(
      resolveOpenCodeTeamLaunchModeFromEnv({ CLAUDE_TEAM_OPENCODE_LAUNCH_MODE: 'dogfood' })
    ).toBe('dogfood');
    expect(
      resolveOpenCodeTeamLaunchModeFromEnv({ CLAUDE_TEAM_OPENCODE_LAUNCH_MODE: 'production' })
    ).toBe('production');
  });

  it('keeps the legacy dogfood flag as an explicit opt-in', () => {
    expect(resolveOpenCodeTeamLaunchModeFromEnv({ CLAUDE_TEAM_OPENCODE_DOGFOOD: '1' })).toBe(
      'dogfood'
    );
  });

  it('falls back to production for invalid launch mode values', () => {
    expect(
      resolveOpenCodeTeamLaunchModeFromEnv({ CLAUDE_TEAM_OPENCODE_LAUNCH_MODE: 'enabled' })
    ).toBe('production');
  });
});
