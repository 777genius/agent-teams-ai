import { AsyncLocalStorage } from 'node:async_hooks';

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

interface TeamProvisioningRequestAdmissionContext {
  active: boolean;
  lockKey: string;
  parent: TeamProvisioningRequestAdmissionContext | undefined;
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

  return service.withTeamLock(lockKey, async () => {
    const context: TeamProvisioningRequestAdmissionContext = {
      active: true,
      lockKey,
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
  const admissionContext = new AsyncLocalStorage<TeamProvisioningRequestAdmissionContext>();
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
