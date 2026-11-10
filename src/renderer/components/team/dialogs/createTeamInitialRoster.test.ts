import { CUSTOM_ROLE } from '@renderer/constants/teamRoles';
import { describe, expect, it } from 'vitest';

import { buildInitialRosterMemberDrafts } from './createTeamInitialRoster';

import type { TeamProvisioningMemberInput } from '@shared/types';

describe('buildInitialRosterMemberDrafts', () => {
  it('starts a new team with the lead only (no teammate drafts)', () => {
    expect(buildInitialRosterMemberDrafts({ multimodelEnabled: true })).toEqual([]);
    expect(buildInitialRosterMemberDrafts({ multimodelEnabled: false })).toEqual([]);
  });

  it('keeps an explicitly empty copied roster empty', () => {
    expect(buildInitialRosterMemberDrafts({ copiedMembers: [], multimodelEnabled: true })).toEqual(
      []
    );
  });

  it('preserves copied members when creating from an existing team', () => {
    const copiedMembers: TeamProvisioningMemberInput[] = [
      { name: 'alice', role: 'reviewer', workflow: 'Review incoming changes' },
      { name: 'bob', role: 'sre-oncall', isolation: 'worktree', providerId: 'opencode' },
    ];

    const drafts = buildInitialRosterMemberDrafts({ copiedMembers, multimodelEnabled: true });

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      name: 'alice',
      roleSelection: 'reviewer',
      customRole: '',
      workflow: 'Review incoming changes',
    });
    expect(drafts[1]).toMatchObject({
      name: 'bob',
      roleSelection: CUSTOM_ROLE,
      customRole: 'sre-oncall',
      isolation: 'worktree',
      providerId: 'opencode',
    });
  });
});
