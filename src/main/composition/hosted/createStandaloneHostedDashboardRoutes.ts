import { join } from 'node:path';

import { createHostedRecentProjectsComposition } from './hostedRecentProjectsComposition';
import { createHostedWorkspaceAccessProjection } from './hostedWorkspaceAccessProjection';
import { createHostedWorkspaceAccessRoutes } from './hostedWorkspaceAccessRoutes';
import { createHostedWorkspaceRegistryComposition } from './hostedWorkspaceRegistryComposition';

import type { HostedTaskBoardReadComposition } from './hostedTaskBoardReadComposition';
import type { HostedTeamMessageComposition } from './hostedTeamMessageComposition';
import type { TeamLifecycleReadHost } from './teamLifecycleReadComposition';
import type { HostedAccessFeature } from '@features/hosted-access/main';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { WorkspaceMountBinding } from '@features/workspace-registry';
import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';

interface StandaloneHostedDashboardRoutesInput {
  readonly access: HostedAccessFeature;
  readonly runtimeInstance: RuntimeInstanceContext | null;
  readonly snapshot: WorkspaceRegistryStartupSnapshot | null;
  readonly currentSnapshot: () => WorkspaceRegistryStartupSnapshot | null;
  readonly ownerBinding: WorkspaceMountBinding | null;
  readonly multiRootActive: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly teamLifecycleReadHost: TeamLifecycleReadHost;
  readonly taskBoardRoutes: HostedTaskBoardReadComposition | undefined;
  readonly messageRoutes: HostedTeamMessageComposition | undefined;
  readonly lifecycleReady: () => boolean;
  readonly configurationReady: () => boolean;
  readonly promotionAvailable: () => boolean;
  readonly messageWriterAvailable: () => boolean;
}

/** Compose the dashboard's admitted routes and live capability predicates at startup. */
export function createStandaloneHostedDashboardRoutes(input: StandaloneHostedDashboardRoutesInput) {
  const { access, runtimeInstance, snapshot, ownerBinding, multiRootActive } = input;
  const hostedWorkspaceRegistryRoutes =
    runtimeInstance === null || snapshot === null
      ? undefined
      : createHostedWorkspaceRegistryComposition({
          authentication: access.http,
          snapshot,
          runtimeInstance,
          expectedDeploymentId: access.deploymentId,
        });
  const ownerWorkspaceId = ownerBinding?.workspaceId ?? null;
  const codexSessionsRoot = input.environment.HOSTED_CODEX_SESSIONS_ROOT;
  const codexArchivedSessionsRoot = input.environment.HOSTED_CODEX_ARCHIVED_SESSIONS_ROOT;
  if ((codexSessionsRoot === undefined) !== (codexArchivedSessionsRoot === undefined)) {
    throw new Error('hosted_codex_metadata_mount_pair_invalid');
  }
  const hostedRecentProjectsRoutes =
    runtimeInstance === null || snapshot === null || ownerBinding === null
      ? undefined
      : createHostedRecentProjectsComposition({
          authentication: access.http,
          snapshot,
          runtimeInstance,
          expectedDeploymentId: access.deploymentId,
          primaryRuntimeWorkspaceId: ownerBinding.workspaceId,
          multiRootActive,
          metadataMounts: {
            claudeProjectsDir: join(runtimeInstance.claudeRoot.reference, 'projects'),
            ...(codexSessionsRoot === undefined || codexArchivedSessionsRoot === undefined
              ? {}
              : {
                  codexSessionsDir: codexSessionsRoot,
                  codexArchivedSessionsDir: codexArchivedSessionsRoot,
                }),
          },
        });
  const hostedWorkspaceAccessRoutes =
    runtimeInstance === null || snapshot === null || ownerBinding === null
      ? undefined
      : createHostedWorkspaceAccessRoutes(
          createHostedWorkspaceAccessProjection({
            authentication: access.http,
            runtimeInstance,
            admittedSnapshot: snapshot,
            currentSnapshot: input.currentSnapshot,
            ownerBinding,
            multiRootActive,
            ownerReady: input.lifecycleReady,
            available: {
              'directory.read': (workspaceId) =>
                input.teamLifecycleReadHost.listForWorkspace !== undefined &&
                (multiRootActive || workspaceId === ownerWorkspaceId),
              'team.open': (workspaceId) =>
                input.teamLifecycleReadHost.listForWorkspace !== undefined &&
                input.taskBoardRoutes?.canReadWorkspace(workspaceId) === true &&
                input.messageRoutes?.canReadWorkspace(workspaceId) === true,
              'task.read': (workspaceId) =>
                input.taskBoardRoutes?.canReadWorkspace(workspaceId) === true,
              'message.read': (workspaceId) =>
                input.messageRoutes?.canReadWorkspace(workspaceId) === true,
              'task.write': (workspaceId) =>
                workspaceId === ownerWorkspaceId &&
                input.lifecycleReady() &&
                input.taskBoardRoutes?.mutationsEnabled === true,
              'message.send': (workspaceId) =>
                workspaceId === ownerWorkspaceId &&
                input.lifecycleReady() &&
                input.messageRoutes !== undefined &&
                input.messageWriterAvailable(),
              'configuration.read': (workspaceId) =>
                workspaceId === ownerWorkspaceId && input.configurationReady(),
              'configuration.write': (workspaceId) =>
                workspaceId === ownerWorkspaceId && input.configurationReady(),
              'promotion.execute': (workspaceId) =>
                workspaceId === ownerWorkspaceId && input.promotionAvailable(),
              'lifecycle.command': (workspaceId) =>
                workspaceId === ownerWorkspaceId && input.lifecycleReady(),
            },
          })
        );
  return { hostedWorkspaceRegistryRoutes, hostedRecentProjectsRoutes, hostedWorkspaceAccessRoutes };
}
