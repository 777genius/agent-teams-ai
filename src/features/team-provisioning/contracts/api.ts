import type { TeamProvisioningRuntimeDeliveryApi } from './runtime-delivery';
import type { TeamProvisioningRuntimeSnapshotApi } from './runtime-snapshot';
import type { TeamProvisioningToolApprovalApi } from './tool-approval';
import type { UpdateMemberSettingsRequest, UpdateMemberSettingsResult } from './memberSettings';
import type { TeamProvisioningProgress } from '@shared/types/team';

export interface TeamProvisioningStatusApi {
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
}

export interface TeamProvisioningApplicationApi
  extends
    TeamProvisioningRuntimeSnapshotApi,
    TeamProvisioningToolApprovalApi,
    TeamProvisioningRuntimeDeliveryApi {}

export interface TeamMemberSettingsApi {
  updateMemberSettings(request: UpdateMemberSettingsRequest): Promise<UpdateMemberSettingsResult>;
}
