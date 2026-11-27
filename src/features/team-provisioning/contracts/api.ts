import type {
  GetMemberSettingsTargetRequest,
  MemberSettingsTarget,
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from './memberSettings';
import type { TeamProvisioningProgress } from '@shared/types/team';

export interface TeamProvisioningStatusApi {
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
}

export interface TeamMemberSettingsApi {
  updateMemberSettings(request: UpdateMemberSettingsRequest): Promise<UpdateMemberSettingsResult>;
  /** The saved settings of a member (null when the team has no such active member). */
  getMemberSettingsTarget(
    request: GetMemberSettingsTargetRequest
  ): Promise<MemberSettingsTarget | null>;
}
