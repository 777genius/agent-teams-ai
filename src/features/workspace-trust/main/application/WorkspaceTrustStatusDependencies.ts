import type { LaunchTrustRequest, LaunchTrustResult } from '../../contracts';

export interface WorkspaceTrustStatusReaderDependency {
  readLaunchStatus(request: LaunchTrustRequest): Promise<LaunchTrustResult>;
}

export interface WorkspaceTrustStatusDependencies {
  createReader(): WorkspaceTrustStatusReaderDependency;
  isLocalContext?: () => boolean;
  validateRequest(value: unknown): LaunchTrustRequest | null;
}
