import type {
  TeamApplicationDataApi,
  TeamApplicationProvisioningStartApi,
  TeamApplicationProvisioningStatusApi,
  TeamApplicationResumeApi,
  TeamApplicationRuntimeIngressApi,
  TeamApplicationTaskActivityApi,
} from '@main/services/team/contracts/TeamApplicationCapabilityApis';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamViewSnapshot,
} from '@shared/types/team';

/**
 * Draft renaming is a persistence concern used only while promoting an
 * already-saved draft. It remains optional so the provider-neutral data
 * capability stays usable by hosted/read-only compositions.
 */
export type TeamApplicationDataPort = TeamApplicationDataApi & {
  renameDraftTeam?(oldTeamName: string, newTeamName: string): Promise<void>;
};

export interface TeamConfigPresencePort {
  hasConfig(teamName: string): Promise<boolean>;
}

export type TeamProvisioningStartPort = TeamApplicationProvisioningStartApi;

export type TeamProvisioningStatusPort = TeamApplicationProvisioningStatusApi;

export type TeamRuntimeIngressPort = TeamApplicationRuntimeIngressApi;

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
  readonly runtimeIngress?: TeamRuntimeIngressPort;
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
