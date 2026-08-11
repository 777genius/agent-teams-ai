import { HOSTED_AUTH_HEADERS } from '../../../../contracts';
import { bodyRecord, type HostedHttpRequest } from '../../../../core/domain';
import { roleAllows } from '../../../../core/domain';

import type {
  HostedAuthenticationContext,
  HostedAuthenticationProvider,
  HostedTeamWorkspaceAttribution,
  HostedTeamWorkspaceGrantFence,
  HostedWorkspaceAccessService,
} from '../../../../core/application';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedRequestGrantFence {
  readonly ownerEffectFence: Readonly<{
    readonly grantRevision: string;
    readonly identityChecksum: string;
  }>;
  revalidate(): Promise<boolean>;
}

export async function isHostedRequestPermissionStillValid(options: {
  readonly request: HostedHttpRequest;
  readonly context: HostedAuthenticationContext | null;
  readonly permission: 'hosted.query' | 'hosted.command';
  readonly trustedOrigin: boolean;
  readonly verifyCsrf: (
    context: HostedAuthenticationContext,
    presented: string
  ) => Promise<boolean>;
}): Promise<boolean> {
  const presented = options.request.headers[HOSTED_AUTH_HEADERS.csrf];
  return (
    options.context !== null &&
    options.trustedOrigin &&
    roleAllows(options.context.principal.role, options.permission) &&
    typeof presented === 'string' &&
    (await options.verifyCsrf(options.context, presented).catch(() => false))
  );
}

export async function resolveLiveHostedRequestContext(options: {
  readonly request: HostedHttpRequest;
  readonly initial: HostedAuthenticationContext | null;
  readonly publicAccessActive: boolean;
  readonly authenticate: HostedAuthenticationProvider['authenticate'];
}): Promise<HostedAuthenticationContext | null> {
  if (!options.publicAccessActive || options.initial === null) return null;
  try {
    const result = await options.authenticate({
      sessionSecret: options.initial.sessionSecret,
      allowRenewal: false,
      sourceIp: options.request.ip,
    });
    return result.authenticated &&
      options.initial.authenticatedSessionId !== undefined &&
      result.context.authenticatedSessionId === options.initial.authenticatedSessionId &&
      result.context.principal.userId === options.initial.principal.userId
      ? result.context
      : null;
  } catch {
    return null;
  }
}

export async function projectLiveHostedWorkspaceEvent(options: {
  readonly request: HostedHttpRequest;
  readonly data: unknown;
  readonly workspaceAccess: HostedWorkspaceAccessService;
  readonly liveRequestContext: (
    request: HostedHttpRequest
  ) => Promise<HostedAuthenticationContext | null>;
}): Promise<unknown | null> {
  const context = await options.liveRequestContext(options.request);
  if (context === null) return null;
  try {
    const source = bodyRecord(options.data);
    const runtimeWorkspaceId =
      typeof source.projectId === 'string'
        ? source.projectId
        : typeof source.workspaceId === 'string'
          ? source.workspaceId
          : null;
    return runtimeWorkspaceId === null
      ? null
      : options.workspaceAccess.projectEvent(
          context.principal.userId,
          runtimeWorkspaceId,
          options.data
        );
  } catch {
    return null;
  }
}

interface CaptureHostedTeamWorkspaceGrantFenceOptions {
  readonly request: HostedHttpRequest;
  readonly teamId: TeamId;
  readonly permission: 'hosted.query' | 'hosted.command';
  readonly workspaceAccess: HostedWorkspaceAccessService;
  readonly resolveTeamWorkspaceId?: (teamId: TeamId) => Promise<HostedTeamWorkspaceAttribution>;
  readonly liveRequestContext: (
    request: HostedHttpRequest
  ) => Promise<HostedAuthenticationContext | null>;
  readonly permissionStillValid: (
    request: HostedHttpRequest,
    context: HostedAuthenticationContext | null,
    permission: 'hosted.query' | 'hosted.command'
  ) => Promise<boolean>;
}

/** Captures auth, session, role, attribution, and durable grant revisions as one live fence. */
export async function captureHostedTeamWorkspaceGrantFence(
  options: CaptureHostedTeamWorkspaceGrantFenceOptions
): Promise<HostedRequestGrantFence | null> {
  const context = await options.liveRequestContext(options.request);
  if (!(await options.permissionStillValid(options.request, context, options.permission))) {
    return null;
  }
  let workspaceFence: HostedTeamWorkspaceGrantFence | null;
  try {
    workspaceFence = await options.workspaceAccess.captureTeamWorkspaceGrantFence(
      context!.principal.userId,
      options.teamId,
      options.resolveTeamWorkspaceId
    );
  } catch {
    return null;
  }
  if (workspaceFence === null) return null;
  const sessionId = context!.authenticatedSessionId;
  const userId = context!.principal.userId;
  const role = context!.principal.role;
  return Object.freeze({
    ownerEffectFence: Object.freeze({
      grantRevision: workspaceFence.grantRevision,
      identityChecksum: workspaceFence.identityChecksum,
    }),
    revalidate: async (): Promise<boolean> => {
      const current = await options.liveRequestContext(options.request);
      if (
        !(await options.permissionStillValid(options.request, current, options.permission)) ||
        current!.authenticatedSessionId !== sessionId ||
        current!.principal.userId !== userId ||
        current!.principal.role !== role
      ) {
        return false;
      }
      return options.workspaceAccess
        .revalidateTeamWorkspaceGrantFence(workspaceFence!, options.resolveTeamWorkspaceId)
        .catch(() => false);
    },
  });
}
