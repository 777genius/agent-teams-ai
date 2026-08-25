import { HostedWorkspaceAccessService } from '../../core/application';
import { HostedAuthHttpController } from '../adapters/input/http/HostedAuthHttpController';

import type { HostedAuthenticatedHttpFacade } from './createHostedAccessFeature';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

export function createHostedAuthenticatedHttpFacade(
  httpController: HostedAuthHttpController,
  workspaceAccess: HostedWorkspaceAccessService,
  authorizeTeamConfigurationScope: (
    request: object,
    scope: Readonly<{ workspaceId: WorkspaceId; teamId?: TeamId }>,
    mutation: boolean
  ) => Promise<'authorized' | 'denied' | 'unavailable'>
): HostedAuthenticatedHttpFacade {
  return Object.freeze({
    allowedOrigin: httpController.allowedOrigin,
    register: (app: unknown) => httpController.register(app as never),
    authenticatedPrincipalFor: (request: object) =>
      httpController.authenticatedPrincipalFor(request),
    resolveGrantedRuntimeWorkspaceId: async (request: object, publicWorkspaceId: string) => {
      const authenticated = httpController.authenticatedPrincipalFor(request);
      if (authenticated === null) return null;
      return (
        (
          await workspaceAccess.resolvePublicGrant(
            authenticated.principal.userId,
            publicWorkspaceId
          )
        )?.runtimeWorkspaceId ?? null
      );
    },
    projectGrantedPublicWorkspaceId: async (request: object, runtimeWorkspaceId: string) => {
      const authenticated = httpController.authenticatedPrincipalFor(request);
      if (authenticated === null) return null;
      return workspaceAccess.projectWorkspaceId(authenticated.principal.userId, runtimeWorkspaceId);
    },
    isWorkspaceRegistered: (workspaceId: string) =>
      httpController.isWorkspaceRegistered(workspaceId),
    projectWorkspaceId: (request: unknown, runtimeWorkspaceId: string) =>
      httpController.projectWorkspaceId(request, runtimeWorkspaceId),
    projectPayload: (request: unknown, payload: unknown) =>
      httpController.projectPayload(request, payload),
    isHostedQueryAuthorized: (request: unknown) => httpController.isHostedQueryAuthorized(request),
    isHostedTaskMutationAuthorized: (request: unknown, teamId: TeamId) =>
      httpController.isHostedTaskMutationAuthorized(request, teamId),
    isTeamWorkspaceAuthorized: (request: unknown, teamId: TeamId) =>
      httpController.isTeamWorkspaceAuthorized(request, teamId),
    isTeamWorkspaceEventAuthorized: (
      request: unknown,
      teamId: TeamId,
      runtimeWorkspaceId: string
    ) => httpController.isTeamWorkspaceEventAuthorized(request, teamId, runtimeWorkspaceId),
    captureTeamWorkspaceGrantFence: (
      request: unknown,
      teamId: TeamId,
      permission: 'hosted.query' | 'hosted.command'
    ) => httpController.captureTeamWorkspaceGrantFence(request, teamId, permission),
    isTeamConfigurationScopeAuthorized: authorizeTeamConfigurationScope,
    isEventStreamAuthorized: (request: unknown) =>
      httpController.isEventStreamAuthorized(request as never),
    projectEvent: (request: unknown, channel: string, data: unknown) =>
      httpController.projectEvent(request as never, channel, data),
  });
}
