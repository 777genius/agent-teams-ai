export type WorkspaceTrustProjectStatus =
  | 'trusted'
  | 'untrusted'
  | 'unknown'
  | 'disabled'
  | 'not_applicable';

export interface WorkspaceTrustProjectStatusRequest {
  projectPath: string;
}

export interface WorkspaceTrustProjectStatusResult {
  status: WorkspaceTrustProjectStatus;
}

export type LaunchTrustProviderId = 'anthropic' | 'codex';

export type ProviderLaunchTrustStatus =
  | { providerId: 'anthropic'; status: WorkspaceTrustProjectStatus }
  | {
      providerId: 'codex';
      status: 'launch_scoped' | 'unknown' | 'disabled' | 'not_applicable';
    };

export interface LaunchTrustRequest {
  projectPath: string;
  providerIds: LaunchTrustProviderId[];
}

export interface LaunchTrustResult {
  providers: ProviderLaunchTrustStatus[];
}

export interface WorkspaceTrustElectronApi {
  workspaceTrust: {
    getLaunchStatus?(request: LaunchTrustRequest): Promise<LaunchTrustResult>;
    getProjectStatus(
      request: WorkspaceTrustProjectStatusRequest
    ): Promise<WorkspaceTrustProjectStatusResult>;
  };
}
