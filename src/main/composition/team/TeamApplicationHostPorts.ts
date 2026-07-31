import type {
  TeamApplicationDataApi,
  TeamApplicationProvisioningStartApi,
  TeamApplicationProvisioningStatusApi,
  TeamApplicationResumeApi,
  TeamApplicationRuntimeApi,
  TeamApplicationTaskActivityApi,
} from '@main/services/team/contracts/TeamApplicationCapabilityApis';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamViewSnapshot,
} from '@shared/types/team';

export type TeamApplicationDataPort = TeamApplicationDataApi;

export interface TeamConfigPresencePort {
  hasConfig(teamName: string): Promise<boolean>;
}

export type TeamProvisioningStartPort = TeamApplicationProvisioningStartApi;

export type TeamProvisioningStatusPort = TeamApplicationProvisioningStatusApi;

export type TeamRuntimePort = TeamApplicationRuntimeApi;

export type TeamTaskActivityPort = TeamApplicationTaskActivityApi;

export type TeamResumePort = TeamApplicationResumeApi;

export interface TeamListInvalidationPort {
  invalidate(): void;
}

export interface TeamApplicationHostPorts {
  readonly configPresence: TeamConfigPresencePort;
  readonly listInvalidation: TeamListInvalidationPort;
  readonly data?: TeamApplicationDataPort;
  readonly provisioningStart?: TeamProvisioningStartPort;
  readonly provisioningStatus?: TeamProvisioningStatusPort;
  readonly runtime?: TeamRuntimePort;
  readonly taskActivity?: TeamTaskActivityPort;
  readonly resume?: TeamResumePort;
}

export interface TeamLaunchRequestBranches {
  createFromDraft(savedRequest: TeamCreateRequest): TeamCreateRequest;
  resumeExisting(): TeamLaunchRequest;
}

export interface PendingTeamDraftView {
  readonly teamName: string;
  readonly pendingCreate: true;
  readonly savedRequest: TeamCreateRequest;
}

export type TeamApplicationView = TeamViewSnapshot | PendingTeamDraftView;
export type TeamApplicationLaunchResult = TeamCreateResponse | TeamLaunchResponse;
