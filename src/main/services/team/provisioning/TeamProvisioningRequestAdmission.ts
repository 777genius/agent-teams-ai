import {
  normalizeRuntimeSelectionVersion,
  requireTeamRuntimeSelection,
} from '@shared/utils/teamRuntimeSelection';

import { TeamConfigReader } from '../TeamConfigReader';
import { captureTeamLaunchPublicationAuthority } from '../TeamLaunchStateStore';
import { TeamMetaStore } from '../TeamMetaStore';

import {
  createTeamInnerWithService,
  launchTeamInnerWithService,
  type TeamProvisioningCreateLaunchOrchestrationServiceHost,
} from './TeamProvisioningCreateLaunchOrchestration';
import {
  type TeamProvisioningRequestAdmissionContext,
  teamProvisioningRequestAdmissionContext,
} from './TeamProvisioningRequestAdmissionContext';

import type { TeamMetaFile } from '../TeamMetaStore';
import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningProgress,
} from '@shared/types';
import type { AsyncLocalStorage } from 'node:async_hooks';

interface TeamProvisioningRequestWithTeamName {
  teamName?: unknown;
  providerId?: unknown;
  runtimeSelectionVersion?: unknown;
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
  run: (runtime: { providerId: TeamProviderId; runtimeSelectionVersion?: 1 }) => Promise<TResult>,
  readTeamMeta: (teamName: string) => Promise<TeamMetaFile | null>
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
    normalizeRuntimeSelectionVersion(request.runtimeSelectionVersion);
    const meta = await readTeamMeta(lockKey);
    const config = await new TeamConfigReader().getConfig(lockKey);
    if (config?.deletedAt || (!config && meta?.deletedAt)) {
      throw new Error('TEAM_TRASHED: Restore the team before launching');
    }
    const runtimeSelectionVersion = normalizeRuntimeSelectionVersion(
      meta?.runtimeSelectionVersion ?? request.runtimeSelectionVersion
    );
    const providerId = requireTeamRuntimeSelection({
      runtimeSelectionVersion,
      providerId: request.providerId ?? meta?.providerId,
    });
    const context: TeamProvisioningRequestAdmissionContext = {
      active: true,
      lockKey,
      publicationIsAuthorized,
      parent: parentContext,
    };
    try {
      return await admissionContext.run(context, () =>
        run({ providerId, ...(runtimeSelectionVersion === 1 ? { runtimeSelectionVersion } : {}) })
      );
    } finally {
      context.active = false;
    }
  });
}

export function createTeamProvisioningRequestAdmissionBoundary(
  service: TeamProvisioningRequestAdmissionServiceHost,
  readTeamMeta: (teamName: string) => Promise<TeamMetaFile | null> = (teamName) =>
    new TeamMetaStore().getMeta(teamName)
): TeamProvisioningRequestAdmissionBoundary {
  const admissionContext = teamProvisioningRequestAdmissionContext;
  return {
    createTeam: (request, onProgress) =>
      runAdmittedTeamProvisioningRequest(
        service,
        admissionContext,
        request,
        (runtime) => createTeamInnerWithService(service, { ...request, ...runtime }, onProgress),
        readTeamMeta
      ),
    launchTeam: (request, onProgress) =>
      runAdmittedTeamProvisioningRequest(
        service,
        admissionContext,
        request,
        async (runtime) => {
          const meta = await readTeamMeta(request.teamName);
          return launchTeamInnerWithService(
            service,
            { ...request, prompt: request.prompt ?? meta?.prompt, ...runtime },
            onProgress
          );
        },
        readTeamMeta
      ),
  };
}
