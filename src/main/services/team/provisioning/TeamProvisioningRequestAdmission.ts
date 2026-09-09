import { captureTeamLaunchPublicationAuthority } from '../TeamLaunchStateStore';

import {
  createTeamInnerWithService,
  launchTeamInnerWithService,
  type TeamProvisioningCreateLaunchOrchestrationServiceHost,
} from './TeamProvisioningCreateLaunchOrchestration';
import {
  type TeamProvisioningRequestAdmissionContext,
  teamProvisioningRequestAdmissionContext,
} from './TeamProvisioningRequestAdmissionContext';

import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';
import type { AsyncLocalStorage } from 'node:async_hooks';

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
  admissionContext: AsyncLocalStorage<TeamProvisioningRequestAdmissionContext>,
  request: TeamProvisioningRequestWithTeamName,
  run: () => Promise<TResult>
): Promise<TResult> {
  const lockKey = getTeamProvisioningRequestLockKey(request);
  const parentContext = admissionContext.getStore();
  for (
    let context: TeamProvisioningRequestAdmissionContext | undefined = parentContext;
    context;
    context = context.parent
  ) {
    if (context.active && context.lockKey === lockKey) {
      throw new Error(`Reentrant team provisioning request for "${lockKey}"`);
    }
  }

  const publicationIsAuthorized = captureTeamLaunchPublicationAuthority(lockKey);
  return service.withTeamLock(lockKey, async () => {
    if (!publicationIsAuthorized()) throw new Error('Launch admission superseded by Stop');
    const context: TeamProvisioningRequestAdmissionContext = {
      active: true,
      lockKey,
      publicationIsAuthorized,
      parent: parentContext,
    };
    try {
      return await admissionContext.run(context, run);
    } finally {
      context.active = false;
    }
  });
}

export function createTeamProvisioningRequestAdmissionBoundary(
  service: TeamProvisioningRequestAdmissionServiceHost
): TeamProvisioningRequestAdmissionBoundary {
  const admissionContext = teamProvisioningRequestAdmissionContext;
  return {
    createTeam: (request, onProgress) =>
      runAdmittedTeamProvisioningRequest(service, admissionContext, request, () =>
        createTeamInnerWithService(service, request, onProgress)
      ),
    launchTeam: (request, onProgress) =>
      runAdmittedTeamProvisioningRequest(service, admissionContext, request, () =>
        launchTeamInnerWithService(service, request, onProgress)
      ),
  };
}
