import { describe, expect, it, vi } from 'vitest';

import {
  type TeamMemberSettingsRelaunchRosterReadPort,
  validateMemberSettingsRelaunchFreshRoster,
} from './validateMemberSettingsRelaunchFreshRoster';

import type { MemberSettingsRelaunchDraft } from './memberSettingsRelaunch';
import type { ResolvedTeamMember } from '@shared/types';

const baselineMembers: ResolvedTeamMember[] = [
  {
    name: 'lead',
    role: 'Team Lead',
    status: 'idle',
    currentTaskId: null,
    taskCount: 0,
    messageCount: 0,
    lastActiveAt: null,
  },
];

const draft: MemberSettingsRelaunchDraft = {
  teamName: 'alpha',
  memberName: 'lead',
  targetKind: 'lead',
  expectedFingerprint: 'unused because the read rejects first',
  expectedTeamSettingsFingerprint: 'unused because the read rejects first',
  settings: {
    role: null,
    workflow: null,
    isolation: null,
    providerId: null,
    providerBackendId: null,
    model: null,
    effort: null,
    fastMode: null,
    mcpPolicy: null,
  },
};

describe('validateMemberSettingsRelaunchFreshRoster', () => {
  it('propagates a fresh roster read failure instead of validating cached state', async () => {
    const failure = new Error('authoritative roster unavailable');
    const readTeamData = vi.fn<TeamMemberSettingsRelaunchRosterReadPort['readTeamData']>(
      async () => {
        throw failure;
      }
    );

    await expect(
      validateMemberSettingsRelaunchFreshRoster({
        teamName: 'alpha',
        baselineMembers,
        draft,
        rosterRead: { readTeamData },
      })
    ).rejects.toBe(failure);

    expect(readTeamData).toHaveBeenCalledTimes(1);
    expect(readTeamData).toHaveBeenCalledWith('alpha');
  });
});
