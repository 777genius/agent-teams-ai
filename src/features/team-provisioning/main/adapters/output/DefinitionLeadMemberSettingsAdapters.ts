import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import { MemberSettingsPersistenceFailedError } from '../../../core/application/ports/UpdateMemberSettingsPorts';
import {
  createMemberSettingsFingerprint,
  isCanonicalLeadTarget,
} from '../../../core/domain/memberSettingsPolicy';

import { backendId, effort, fastMode, optionalText, providerId } from './memberSettingsValues';

import type { MemberSettingsEffort, MemberSettingsTarget } from '../../../contracts/memberSettings';
import type {
  ApplyMemberSettingsResult,
  MemberSettingsLifecyclePort,
  MemberSettingsRepositoryPort,
} from '../../../core/application/ports/UpdateMemberSettingsPorts';
import type { MemberSettingsTargetSnapshot } from '../../../core/domain/memberSettingsPolicy';

/**
 * The launch settings of a team definition (a team with separate history per
 * project): where its lead's provider, model and effort live.
 */
export interface DefinitionLaunchSettingsPort {
  read(teamName: string): Promise<{
    providerId?: unknown;
    providerBackendId?: unknown;
    model?: unknown;
    effort?: unknown;
    fastMode?: unknown;
  }>;
  /** A key set to undefined goes back to the provider default. */
  save(
    teamName: string,
    settings: { model: string | undefined; effort: MemberSettingsEffort | undefined }
  ): Promise<void>;
}

interface LeadRuntimeRollback {
  model: string | null;
  effort: MemberSettingsEffort | null;
}

function isLeadRuntimeRollback(value: unknown): value is LeadRuntimeRollback {
  return typeof value === 'object' && value !== null && 'model' in value && 'effort' in value;
}

/**
 * The lead of a team definition for the member settings use case. The lead has
 * no member settings of its own there: its provider, backend, model, effort and
 * fast mode are the definition's launch settings, so they are always read from
 * them (never from a member row, which the definition does not own) and a save
 * writes model and effort back to them. A definition never runs: the caller
 * holds the definition write (every project stopped), so the target is offline.
 * Any other member is the saved target as is.
 */
export class DefinitionLeadMemberSettingsRepositoryAdapter implements MemberSettingsRepositoryPort {
  constructor(
    private readonly base: MemberSettingsRepositoryPort,
    private readonly launchSettings: DefinitionLaunchSettingsPort
  ) {}

  async findTarget(
    teamName: string,
    memberName: string
  ): Promise<MemberSettingsTargetSnapshot | null> {
    const target = await this.base.findTarget(teamName, memberName);
    if (!target || !isCanonicalLeadTarget(target)) return target;
    const launch = await this.launchSettings.read(teamName);
    const leadProviderId = providerId(launch.providerId);
    return {
      ...target,
      teamIsAlive: false,
      leadProviderId,
      settings: {
        ...target.settings,
        providerId: leadProviderId,
        providerBackendId: backendId(
          migrateProviderBackendId(
            leadProviderId ?? undefined,
            optionalText(launch.providerBackendId) ?? undefined
          )
        ),
        model: optionalText(launch.model),
        effort: effort(launch.effort),
        fastMode: fastMode(launch.fastMode),
      },
    };
  }

  classifyMissingTarget(teamName: string): Promise<'member_not_found' | 'team_not_found'> {
    return this.base.classifyMissingTarget(teamName);
  }

  async applyTarget(input: {
    teamName: string;
    memberName: string;
    expectedFingerprint: string;
    settings: MemberSettingsTarget['settings'];
  }): Promise<ApplyMemberSettingsResult> {
    const current = await this.findTarget(input.teamName, input.memberName);
    if (
      !current ||
      !isCanonicalLeadTarget(current) ||
      createMemberSettingsFingerprint(current) !== input.expectedFingerprint
    ) {
      return { outcome: 'target_conflict', current };
    }
    const rollbackToken: LeadRuntimeRollback = {
      model: current.settings.model,
      effort: current.settings.effort,
    };
    await this.launchSettings.save(input.teamName, {
      model: input.settings.model ?? undefined,
      effort: input.settings.effort ?? undefined,
    });
    const snapshot = await this.findTarget(input.teamName, current.name);
    if (!snapshot) {
      throw new MemberSettingsPersistenceFailedError(
        `The lead of ${input.teamName} disappeared after its launch settings were saved`,
        true
      );
    }
    return { outcome: 'applied', snapshot, rollbackToken };
  }

  async restoreTarget(input: {
    teamName: string;
    memberName: string;
    expectedFingerprint: string;
    snapshot: MemberSettingsTargetSnapshot;
    rollbackToken: unknown;
  }): Promise<boolean> {
    const current = await this.findTarget(input.teamName, input.memberName);
    if (
      !current ||
      createMemberSettingsFingerprint(current) !== input.expectedFingerprint ||
      !isLeadRuntimeRollback(input.rollbackToken)
    ) {
      return false;
    }
    await this.launchSettings.save(input.teamName, {
      model: input.rollbackToken.model ?? undefined,
      effort: input.rollbackToken.effort ?? undefined,
    });
    return true;
  }
}

/**
 * A team definition has no runtime: a saved lead setting is used by the next
 * launch in any project, as for a stopped ordinary team (`persisted_only`).
 */
export const definitionMemberSettingsLifecycle: MemberSettingsLifecyclePort = {
  assess: () => Promise.resolve({ outcome: 'ready' }),
  applyEffect: () => Promise.resolve('persisted_only'),
  restore: () => Promise.resolve(true),
};
