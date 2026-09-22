import type {
  EditableMemberSettings,
  UpdateMemberSettingsEffect,
} from '../../../contracts/memberSettings';
import type {
  MemberSettingsLifecycleAction,
  MemberSettingsTargetSnapshot,
} from '../../domain/memberSettingsPolicy';

export class MemberSettingsPersistenceFailedError extends Error {
  constructor(
    message: string,
    readonly recoveryRequired: boolean,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MemberSettingsPersistenceFailedError';
  }
}

export class MemberSettingsMutationBusyError extends Error {
  constructor(readonly teamName: string) {
    super(`Team mutation is already in progress: ${teamName}`);
    this.name = 'MemberSettingsMutationBusyError';
  }
}

export class MemberSettingsLifecycleFailedError extends Error {
  constructor(
    message: string,
    readonly lifecycleRestored: boolean,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MemberSettingsLifecycleFailedError';
  }
}

export type MemberSettingsLifecycleAdmission =
  | { outcome: 'ready'; token?: unknown }
  | { outcome: 'busy' }
  | { outcome: 'relaunch_required' };

export interface MemberSettingsMutationGatePort {
  runExclusive<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
}

export type ApplyMemberSettingsResult =
  | { outcome: 'applied'; snapshot: MemberSettingsTargetSnapshot; rollbackToken: unknown }
  | { outcome: 'target_conflict'; current: MemberSettingsTargetSnapshot | null };

export interface MemberSettingsRepositoryPort {
  findTarget(teamName: string, memberName: string): Promise<MemberSettingsTargetSnapshot | null>;
  classifyMissingTarget(teamName: string): Promise<'member_not_found' | 'team_not_found'>;
  applyTarget(input: {
    teamName: string;
    memberName: string;
    expectedFingerprint: string;
    settings: EditableMemberSettings;
  }): Promise<ApplyMemberSettingsResult>;
  restoreTarget(input: {
    teamName: string;
    memberName: string;
    expectedFingerprint: string;
    snapshot: MemberSettingsTargetSnapshot;
    rollbackToken: unknown;
  }): Promise<boolean>;
}

export type MemberSettingsLifecycleEffect = Exclude<
  UpdateMemberSettingsEffect,
  'no_changes' | 'recovery_required'
>;

export interface MemberSettingsLifecyclePort {
  assess(input: {
    teamName: string;
    before: MemberSettingsTargetSnapshot;
    proposed: MemberSettingsTargetSnapshot;
    action: Exclude<MemberSettingsLifecycleAction, 'none'>;
  }): Promise<MemberSettingsLifecycleAdmission>;
  applyEffect(input: {
    teamName: string;
    before: MemberSettingsTargetSnapshot;
    after: MemberSettingsTargetSnapshot;
    action: Exclude<MemberSettingsLifecycleAction, 'none'>;
    admission: Extract<MemberSettingsLifecycleAdmission, { outcome: 'ready' }>;
  }): Promise<MemberSettingsLifecycleEffect>;
  restore(input: {
    teamName: string;
    before: MemberSettingsTargetSnapshot;
    after: MemberSettingsTargetSnapshot;
    attemptedAction: Exclude<MemberSettingsLifecycleAction, 'none'>;
  }): Promise<boolean>;
}
