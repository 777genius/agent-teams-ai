import type {
  MemberSettingsLifecycleEffect,
  MemberSettingsLifecyclePort,
} from '../../../core/application/ports/UpdateMemberSettingsPorts';

export interface LegacyMemberSettingsLifecycleSource {
  attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options: { reason: 'member_updated' }
  ): Promise<void>;
  isTeamAlive(teamName: string): boolean;
}

/** Keeps provider/runtime mechanics behind the existing focused attach operation. */
export class LegacyMemberSettingsLifecycleAdapter implements MemberSettingsLifecyclePort {
  constructor(private readonly source: LegacyMemberSettingsLifecycleSource) {}

  async applyEffect(
    input: Parameters<MemberSettingsLifecyclePort['applyEffect']>[0]
  ): Promise<MemberSettingsLifecycleEffect> {
    if (input.action === 'require_team_relaunch') {
      throw new Error('Team relaunch must be initiated by an explicit relaunch command');
    }
    if (!this.source.isTeamAlive(input.teamName)) {
      return 'persisted_only';
    }

    await this.source.attachLiveRosterMember(input.teamName, input.after.name, {
      reason: 'member_updated',
    });
    return input.action === 'restart_opencode_lane'
      ? 'opencode_lane_restart_started'
      : 'member_restart_started';
  }

  // eslint-disable-next-line sonarjs/no-invariant-returns -- Successful completion is the factual rollback result; failures throw.
  async restore(input: Parameters<MemberSettingsLifecyclePort['restore']>[0]): Promise<boolean> {
    if (input.attemptedAction === 'require_team_relaunch') {
      return true;
    }
    if (!this.source.isTeamAlive(input.teamName)) {
      return true;
    }

    await this.source.attachLiveRosterMember(input.teamName, input.before.name, {
      reason: 'member_updated',
    });
    return true;
  }
}
