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
    captureWorkspaceReadGrantFence: async (request: object, publicWorkspaceId: string) => {
      if (!(await httpController.isHostedQueryAuthorized(request))) return null;
      const authenticated = await httpController.liveAuthenticatedPrincipalFor(request);
      if (authenticated === null) return null;
      const grantSet = await workspaceAccess.captureWorkspaceGrantSetFence(
        authenticated.principal.userId
      );
      const grant = grantSet.grants.find((entry) => entry.workspaceId === publicWorkspaceId);
      if (!grant) return null;
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(grantSet.grants))
      );
      const grantSetFingerprint = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      return Object.freeze({
        runtimeWorkspaceId: grant.runtimeWorkspaceId,
        grantRevision: grant.grantRevision,
        grantSetFingerprint,
        revalidate: async () => {
          if (!(await httpController.isHostedQueryAuthorized(request))) return false;
          const current = await httpController.liveAuthenticatedPrincipalFor(request);
          return (
            current !== null &&
            current.authenticatedSessionId === authenticated.authenticatedSessionId &&
            current.principal.userId === authenticated.principal.userId &&
            current.principal.role === authenticated.principal.role &&
            (await workspaceAccess.revalidateWorkspaceGrantSetFence(grantSet))
          );
        },
      });
    },
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
