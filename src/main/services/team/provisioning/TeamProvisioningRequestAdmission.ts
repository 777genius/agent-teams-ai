import {
  createTeamInnerWithService,
  launchTeamInnerWithService,
  type TeamProvisioningCreateLaunchOrchestrationServiceHost,
} from './TeamProvisioningCreateLaunchOrchestration';

import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

interface TeamProvisioningRequestWithTeamName {
  teamName?: unknown;
}

export interface TeamProvisioningRequestAdmissionServiceHost extends TeamProvisioningCreateLaunchOrchestrationServiceHost {
  withTeamLock<T>(teamName: string, fn: () => Promise<T>): Promise<T>;
}

export interface TeamProvisioningRequestAdmissionBoundary {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
}

export function getTeamProvisioningRequestLockKey(
  request: TeamProvisioningRequestWithTeamName
): string {
  if (typeof request.teamName !== 'string' || request.teamName.trim().length === 0) {
    throw new Error('Team name is required');
  }
  return request.teamName;
}

async function runAdmittedTeamProvisioningRequest<TResult>(
  service: TeamProvisioningRequestAdmissionServiceHost,
  request: TeamProvisioningRequestWithTeamName,
  run: () => Promise<TResult>
): Promise<TResult> {
  const lockKey = getTeamProvisioningRequestLockKey(request);
  return service.withTeamLock(lockKey, run);
}

export function createTeamProvisioningRequestAdmissionBoundary(
  service: TeamProvisioningRequestAdmissionServiceHost
): TeamProvisioningRequestAdmissionBoundary {
  return {
    createTeam: (request, onProgress) =>
      runAdmittedTeamProvisioningRequest(service, request, () =>
        createTeamInnerWithService(service, request, onProgress)
      ),
    launchTeam: (request, onProgress) =>
      runAdmittedTeamProvisioningRequest(service, request, () =>
        launchTeamInnerWithService(service, request, onProgress)
      ),
  };
}
