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

export interface WorkspaceTrustElectronApi {
  workspaceTrust: {
    getProjectStatus(
      request: WorkspaceTrustProjectStatusRequest
    ): Promise<WorkspaceTrustProjectStatusResult>;
  };
}
