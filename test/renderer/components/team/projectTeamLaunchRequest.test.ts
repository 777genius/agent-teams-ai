import { describe, expect, it } from 'vitest';

import { toLogicalProjectLaunchRequest } from '../../../../src/renderer/components/team/projectTeamLaunchRequest';

import type { TeamLaunchRequest } from '../../../../src/shared/types/team';

describe('project launch request policy', () => {
  it('does not escalate approval-required runs into auto-approved runs', () => {
    const form: TeamLaunchRequest = {
      teamName: 'ptc-physical-context',
      cwd: '/project/alias',
      providerId: 'anthropic',
      model: 'sonnet',
      skipPermissions: false,
      effort: 'high',
      fastMode: 'off',
    };
    const result = toLogicalProjectLaunchRequest(form, 'builders', '/project/canonical');
    expect(result).toEqual({
      ...form,
      teamName: 'builders',
      cwd: '/project/canonical',
    });
    expect(result.skipPermissions).toBe(false);
  });

  it('retains explicit launch overrides and the submitted cwd when no saved path exists', () => {
    const form: TeamLaunchRequest = {
      teamName: 'ptc-runtime',
      cwd: '/project/worktree',
      providerId: 'codex',
      model: 'gpt-5',
      skipPermissions: false,
      extraCliArgs: '--foo',
    };
    const result = toLogicalProjectLaunchRequest(form, 'builders');
    expect(result).toMatchObject({
      teamName: 'builders',
      cwd: '/project/worktree',
      model: 'gpt-5',
      skipPermissions: false,
      extraCliArgs: '--foo',
    });
  });
});
