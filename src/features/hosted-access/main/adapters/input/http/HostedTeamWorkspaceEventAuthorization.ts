import { type HostedHttpRequest, roleAllows } from '../../../../core/domain';

import type {
  HostedAuthenticationContext,
  HostedTeamWorkspaceAttribution,
  HostedWorkspaceAccessService,
} from '../../../../core/application';
import type { TeamId } from '@shared/contracts/hosted';

export async function isHostedTeamWorkspaceEventAuthorized(options: {
  readonly request: HostedHttpRequest;
  readonly teamId: TeamId;
  readonly runtimeWorkspaceId: string;
  readonly workspaceAccess: HostedWorkspaceAccessService;
  readonly resolveTeamWorkspaceId?: (teamId: TeamId) => Promise<HostedTeamWorkspaceAttribution>;
  readonly liveRequestContext: (
    request: HostedHttpRequest
  ) => Promise<HostedAuthenticationContext | null>;
}): Promise<boolean> {
  const context = await options.liveRequestContext(options.request);
  if (context === null || !roleAllows(context.principal.role, 'hosted.events')) return false;
  try {
    const fence = await options.workspaceAccess.captureTeamWorkspaceGrantFence(
      context.principal.userId,
      options.teamId,
      options.resolveTeamWorkspaceId
    );
    return (
      fence !== null &&
      fence.runtimeWorkspaceId === options.runtimeWorkspaceId &&
      (await options.workspaceAccess.revalidateTeamWorkspaceGrantFence(
        fence,
        options.resolveTeamWorkspaceId
      ))
    );
  } catch {
    return false;
  }
}

export async function isHostedTeamWorkspaceAuthorized(options: {
  readonly request: HostedHttpRequest;
  readonly teamId: TeamId;
  readonly workspaceAccess: HostedWorkspaceAccessService;
  readonly resolveTeamWorkspaceId?: (teamId: TeamId) => Promise<HostedTeamWorkspaceAttribution>;
  readonly liveRequestContext: (
    request: HostedHttpRequest
  ) => Promise<HostedAuthenticationContext | null>;
}): Promise<boolean> {
  const context = await options.liveRequestContext(options.request);
  if (context === null) return false;
  return options.workspaceAccess
    .hasTeamWorkspaceGrant(context.principal.userId, options.teamId, options.resolveTeamWorkspaceId)
    .catch(() => false);
}
