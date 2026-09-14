import type {
  LaunchTrustRequest,
  LaunchTrustResult,
  WorkspaceTrustProjectStatusRequest,
  WorkspaceTrustProjectStatusResult,
} from '../../contracts';

export interface WorkspaceTrustStatusTransport {
  getLaunchStatus?(request: LaunchTrustRequest): Promise<LaunchTrustResult>;
  getProjectStatus(
    request: WorkspaceTrustProjectStatusRequest
  ): Promise<WorkspaceTrustProjectStatusResult>;
}

export interface WorkspaceTrustStatusPorts {
  localReadAllowed: boolean;
  sourceKey: string;
  transport: WorkspaceTrustStatusTransport | null | undefined;
}
