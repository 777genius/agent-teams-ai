import { join } from 'node:path';

import { TeamProvisioningService } from '../TeamProvisioningService';

import {
  createHostedApprovalRuntimeAdmissionComposition,
  HOSTED_APPROVAL_RUNTIME_ORCHESTRATOR_CAPABILITY,
  HOSTED_APPROVAL_RUNTIME_PRODUCTION_ELIGIBLE,
} from './HostedApprovalRuntimeAdmissionComposition';
import { createHostedApprovalRuntimeAuthoritativeEvidenceAdapter } from './HostedApprovalRuntimeAuthoritativeEvidenceAdapter';

import type { HostedApprovalRuntimeAdmissionCoordinator } from './HostedApprovalRuntimeAdmissionComposition';
import type { HostedApprovalRuntimeTransitionAuthority } from './HostedApprovalRuntimeAuthoritativeEvidenceAdapter';

/** Constructor composition for the compatibility facade; no post-construction capability slots. */
export function createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(
  coordinator: HostedApprovalRuntimeAdmissionCoordinator | null,
  transitionAuthority: HostedApprovalRuntimeTransitionAuthority | null = null
): TeamProvisioningService {
  return new TeamProvisioningService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    coordinator,
    transitionAuthority
  );
}

/**
 * Product-owned production composition. Both admission gates intentionally remain false; the real
 * request-scoped authority adapter is nevertheless wired now so promotion cannot fall back to
 * workspace-derived or ambient evidence.
 */
export function createProductOwnedTeamProvisioningService(
  teamsBasePath: string,
  stateDirectoryPath: string
): TeamProvisioningService {
  const authoritativeEvidence = createHostedApprovalRuntimeAuthoritativeEvidenceAdapter();
  const coordinator = createHostedApprovalRuntimeAdmissionComposition({
    enabled:
      HOSTED_APPROVAL_RUNTIME_PRODUCTION_ELIGIBLE &&
      HOSTED_APPROVAL_RUNTIME_ORCHESTRATOR_CAPABILITY,
    resolveTeamDirectoryPath: (teamName) => join(teamsBasePath, teamName),
    stateDirectoryPath,
    authoritativeEvidence,
  });
  return createTeamProvisioningServiceWithHostedApprovalRuntimeAdmission(
    coordinator,
    authoritativeEvidence
  );
}
