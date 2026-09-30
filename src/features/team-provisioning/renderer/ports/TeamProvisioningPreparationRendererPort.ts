import type { TeamProvisioningPreparationRendererPorts } from './TeamProvisioningPreparationRendererPorts';
import type {
  WorkspaceTrustProjectStatusRequest,
  WorkspaceTrustProjectStatusResult,
} from '@features/workspace-trust/contracts';

export interface TeamProvisioningPreparationRendererPort extends TeamProvisioningPreparationRendererPorts {
  getWorkspaceTrustProjectStatus?: (
    request: WorkspaceTrustProjectStatusRequest
  ) => Promise<WorkspaceTrustProjectStatusResult>;
}
