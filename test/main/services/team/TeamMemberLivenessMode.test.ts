import { describe, expect, it } from 'vitest';

import {
  CLAUDE_TEAM_MEMBER_LIVENESS_MODE_ENV,
  resolveTeamMemberLivenessModeFromEnv,
} from '@main/services/team/TeamMemberLivenessMode';

describe('resolveTeamMemberLivenessModeFromEnv', () => {
  it('defaults to diagnostics', () => {
    expect(resolveTeamMemberLivenessModeFromEnv({})).toBe('diagnostics');
  });

  it('enables strict mode explicitly', () => {
    expect(
      resolveTeamMemberLivenessModeFromEnv({
        [CLAUDE_TEAM_MEMBER_LIVENESS_MODE_ENV]: 'strict',
      })
    ).toBe('strict');
  });

  it('falls back to diagnostics for unknown values', () => {
    expect(
      resolveTeamMemberLivenessModeFromEnv({
        [CLAUDE_TEAM_MEMBER_LIVENESS_MODE_ENV]: 'yes',
      })
    ).toBe('diagnostics');
  });
});
