import { MemberSettingsLifecycleFailedError } from '../../../core/application/ports/UpdateMemberSettingsPorts';

import type {
  MemberSettingsLifecycleAdmission,
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
  assessLeadRuntimeRestart?(input: {
    teamName: string;
    providerId: 'anthropic' | 'codex' | 'gemini';
    model: string | null;
    effort: import('../../../contracts/memberSettings').MemberSettingsEffort | null;
  }): Promise<MemberSettingsLifecycleAdmission>;
  restartLeadRuntime?(input: {
    teamName: string;
    expectedRunId: string;
    before: {
      providerId: 'anthropic' | 'codex' | 'gemini';
      model: string | null;
      effort: import('../../../contracts/memberSettings').MemberSettingsEffort | null;
    };
    after: {
      providerId: 'anthropic' | 'codex' | 'gemini';
      model: string | null;
      effort: import('../../../contracts/memberSettings').MemberSettingsEffort | null;
    };
  }): Promise<void>;
  persistLeadRuntimeSettings?(input: {
    teamName: string;
    settings: {
      providerId: 'anthropic' | 'codex' | 'gemini';
      model: string | null;
      effort: import('../../../contracts/memberSettings').MemberSettingsEffort | null;
    };
  }): Promise<void>;
}

/** Keeps provider/runtime mechanics behind the existing focused attach operation. */
export class LegacyMemberSettingsLifecycleAdapter implements MemberSettingsLifecyclePort {
  constructor(private readonly source: LegacyMemberSettingsLifecycleSource) {}

  async assess(
    input: Parameters<MemberSettingsLifecyclePort['assess']>[0]
  ): Promise<MemberSettingsLifecycleAdmission> {
    if (input.action !== 'restart_lead') return { outcome: 'ready' };
    const providerId = input.proposed.leadProviderId;
    if (!this.source.isTeamAlive(input.teamName)) {
      return this.source.persistLeadRuntimeSettings &&
        (providerId === 'anthropic' || providerId === 'codex' || providerId === 'gemini')
        ? { outcome: 'ready' }
        : { outcome: 'relaunch_required' };
    }
    if (
      !this.source.assessLeadRuntimeRestart ||
      (providerId !== 'anthropic' && providerId !== 'codex' && providerId !== 'gemini')
    ) {
      return { outcome: 'relaunch_required' };
    }
    return this.source.assessLeadRuntimeRestart({
      teamName: input.teamName,
      providerId,
      model: input.proposed.settings.model,
      effort: input.proposed.settings.effort,
    });
  }

  async applyEffect(
    input: Parameters<MemberSettingsLifecyclePort['applyEffect']>[0]
  ): Promise<MemberSettingsLifecycleEffect> {
    if (input.action === 'require_team_relaunch') {
      throw new Error('Team relaunch must be initiated by an explicit relaunch command');
    }
    if (input.action === 'restart_lead') {
      const providerId = input.after.leadProviderId;
      if (!this.source.isTeamAlive(input.teamName)) {
        if (
          !this.source.persistLeadRuntimeSettings ||
          (providerId !== 'anthropic' && providerId !== 'codex' && providerId !== 'gemini')
        ) {
          throw new Error('Offline lead settings persistence is unavailable');
        }
        await this.source.persistLeadRuntimeSettings({
          teamName: input.teamName,
          settings: {
            providerId,
            model: input.after.settings.model,
            effort: input.after.settings.effort,
          },
        });
        return 'persisted_only';
      }
      const expectedRunId =
        typeof input.admission.token === 'string' ? input.admission.token : null;
      if (
        !this.source.restartLeadRuntime ||
        !expectedRunId ||
        (providerId !== 'anthropic' && providerId !== 'codex' && providerId !== 'gemini')
      ) {
        throw new Error('Lead-only runtime restart admission is unavailable');
      }
      try {
        await this.source.restartLeadRuntime({
          teamName: input.teamName,
          expectedRunId,
          before: {
            providerId,
            model: input.before.settings.model,
            effort: input.before.settings.effort,
          },
          after: {
            providerId,
            model: input.after.settings.model,
            effort: input.after.settings.effort,
          },
        });
      } catch (error) {
        const lifecycleRestored =
          typeof error === 'object' &&
          error !== null &&
          (error as { lifecycleRestored?: unknown }).lifecycleRestored === true;
        throw new MemberSettingsLifecycleFailedError(
          error instanceof Error ? error.message : String(error),
          lifecycleRestored,
          error
        );
      }
      return 'lead_restart_started';
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

    if (input.attemptedAction === 'restart_lead') {
      // The lead runtime port performs its own bounded rollback before it
      // reports lifecycle failure. A false recovery result is propagated by
      // MemberSettingsLifecycleFailedError and never reaches this fallback.
      return false;
    }

    await this.source.attachLiveRosterMember(input.teamName, input.before.name, {
      reason: 'member_updated',
    });
    return true;
  }
}
