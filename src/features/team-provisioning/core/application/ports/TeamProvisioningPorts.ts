import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamFastMode,
  TeamLaunchFailureDiagnosticsBundle,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
} from '@shared/types';

export interface TeamProvisioningStartPort {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
}

export interface TeamProvisioningPreflightPort {
  getCliHelpOutput(): Promise<string>;
  prepareForProvisioning(
    cwd?: string,
    options?: {
      providerId?: TeamProviderId;
      providerIds?: TeamProviderId[];
      modelIds?: string[];
      limitContext?: boolean;
      modelVerificationMode?: TeamProvisioningModelVerificationMode;
      modelChecks?: TeamProvisioningModelCheckRequest[];
    }
  ): Promise<TeamProvisioningPrepareResult>;
}

export interface TeamProvisioningStatusPort {
  getStatus(runId: string): Promise<TeamProvisioningProgress>;
}

export interface TeamProvisioningCancellationPort {
  cancel(runId: string): Promise<void>;
}

export interface TeamProvisioningRepositoryPort {
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
}

export interface TeamLaunchMetadata {
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: string;
  fastMode?: TeamFastMode;
  limitContext?: boolean;
  launchIdentity?: ProviderModelLaunchIdentity;
}

export interface TeamProvisioningWorkspacePort {
  ensureDirectory(path: string): Promise<boolean>;
  getDirectoryStatus(path: string): Promise<'directory' | 'not-directory' | 'missing'>;
  isAbsolute(path: string): boolean;
  hasTeamConfig(teamName: string): Promise<boolean>;
  getMetadata(teamName: string): Promise<TeamLaunchMetadata | null>;
}

export interface TeamProvisioningEffectsPort {
  addBreadcrumb(operation: 'create' | 'launch', teamName: string): void;
  noteLaunchIntent(teamName: string, source: 'create' | 'draft-launch' | 'launch'): void;
  markTeamEngaged(teamName: string): void;
  noteProgress(progress: TeamProvisioningProgress): void;
  noteFailureBeforeProgress(teamName: string, source: string): void;
  invalidateRosterSnapshots(teamName: string): void;
}

export interface TeamLaunchDiagnosticsPort {
  read(teamName: string, runId?: string): Promise<TeamLaunchFailureDiagnosticsBundle>;
}

export interface TeamProvisioningLoggerPort {
  error(message: string): void;
}
