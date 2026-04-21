import { describe, expect, it } from 'vitest';

import {
  applyOpenCodeAutoUpdatePolicy,
  isOpenCodeAutoUpdateAllowed,
} from '../../../../src/main/services/runtime/openCodeAutoUpdatePolicy';

describe('openCodeAutoUpdatePolicy', () => {
  it('disables OpenCode auto-update by default for app-managed envs', () => {
    const input = { PATH: '/usr/bin' };

    const result = applyOpenCodeAutoUpdatePolicy(input);

    expect(result).toEqual({
      PATH: '/usr/bin',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    expect(input).toEqual({ PATH: '/usr/bin' });
  });

  it('allows an explicit app override to remove inherited disable-auto-update', () => {
    const result = applyOpenCodeAutoUpdatePolicy({
      CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });

    expect(result.CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE).toBe('1');
    expect(result.OPENCODE_DISABLE_AUTOUPDATE).toBeUndefined();
    expect(isOpenCodeAutoUpdateAllowed(result)).toBe(true);
  });

  it('treats non-enabled override values as fail-closed', () => {
    const result = applyOpenCodeAutoUpdatePolicy({
      CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE: '0',
    });

    expect(result.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(isOpenCodeAutoUpdateAllowed(result)).toBe(false);
  });
});
