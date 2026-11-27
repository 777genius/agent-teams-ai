import { describe, expect, it } from 'vitest';

import {
  buildLaunchOptionalSummary,
  type LaunchOptionalSummaryInput,
} from '@renderer/components/team/dialogs/createTeamOptionalSummary';

const t = ((key: string) => key) as never;

const base: LaunchOptionalSummaryInput = {
  launchTeam: true,
  projectContextMode: 'per_project',
  prompt: '',
  skipPermissions: false,
  selectedProviderId: 'opencode',
  selectedFastMode: undefined,
  anthropicProviderFastModeDefault: false,
  limitAnthropicContext: false,
  worktreeEnabled: false,
  worktreeName: '',
  customArgs: '',
};

describe('buildLaunchOptionalSummary', () => {
  it('shows only the history mode when the team is not launched', () => {
    expect(
      buildLaunchOptionalSummary(
        { ...base, launchTeam: false, prompt: 'x', skipPermissions: true, customArgs: '--a' },
        t
      )
    ).toEqual(['create.optional.summary.historyPerProject']);
  });

  it('names the shared mode', () => {
    expect(
      buildLaunchOptionalSummary({ ...base, launchTeam: false, projectContextMode: 'shared' }, t)
    ).toEqual(['create.optional.summary.historyShared']);
  });

  it('puts the history chip last so changed launch settings keep the visible slots', () => {
    const summary = buildLaunchOptionalSummary(
      { ...base, prompt: 'lead prompt', skipPermissions: true, customArgs: '--a' },
      t
    );
    expect(summary).toEqual([
      'create.optional.summary.leadPrompt',
      'create.optional.summary.autoApproveTools',
      'create.optional.summary.customCliArgs',
      'create.optional.summary.historyPerProject',
    ]);
  });
});
