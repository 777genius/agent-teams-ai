/**
 * HTTP Route Registration Orchestrator.
 *
 * Registers all domain-specific route handlers on a Fastify instance.
 * Each route file mirrors the corresponding IPC handler.
 */

import {
  createInternalStorageFeature,
  type InternalStorageHostedAuthFeature,
} from '@features/internal-storage/main';
import {
  type OrganizationsFeatureFacade,
  registerOrganizationsHttp,
} from '@features/organizations/main';
import {
  type RecentProjectsFeatureFacade,
  registerRecentProjectsHttp,
} from '@features/recent-projects/main';
import { registerTokenUsageHttp, type TokenUsageFeatureFacade } from '@features/token-usage/main';
import { createLogger } from '@shared/utils/logger';

import { registerConfigRoutes } from './config';
import { registerEventRoutes } from './events';
import { registerNotificationRoutes } from './notifications';
import { registerProjectRoutes } from './projects';
import { registerSearchRoutes } from './search';
import { registerSessionRoutes } from './sessions';
import { registerSshRoutes } from './ssh';
import { registerSubagentRoutes } from './subagents';
import { registerTeamRoutes } from './teams';
import { registerUpdaterRoutes } from './updater';
import { registerUtilityRoutes } from './utility';
import { registerValidationRoutes } from './validation';

import type {
  ChunkBuilder,
  DataCache,
  ProjectScanner,
  SessionParser,
  SubagentResolver,
  UpdaterService,
} from '../services';
import type { SshConnectionManager } from '../services/infrastructure/SshConnectionManager';
import type {
  TeamHttpDataApi,
  TeamHttpHandlerApis,
} from '../services/team/contracts/TeamProvisioningApis';
import type { HostedAuthHttpFacade } from '@features/hosted-access/main';
import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type { TeamLifecycleReadHost } from '@main/composition/hosted/teamLifecycleReadComposition';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:routes');

export type HostedAuthStorageBackend = InternalStorageHostedAuthFeature;

export interface HostedTeamTaskBoardRouteContribution {
  register(app: FastifyInstance): void;
}

export interface HostedTeamMessageRouteContribution {
  register(app: FastifyInstance): void;
}

export interface HostedCoordinationEventRouteContribution {
  register(app: FastifyInstance): void;
}

export interface HostedDiagnosticsRouteContribution {
  register(app: FastifyInstance): void;
}

export interface HostedLifecycleCommandRouteContribution {
  register(app: FastifyInstance): void;
}

/**
 * Process composition for the hosted-only SQLite capability. The existing
 * internal-storage public factory remains the feature boundary while this
 * outer host prevents desktop journals and fallback stores from being built.
 */
export function createHostedAuthStorageBackend(userDataPath: string): HostedAuthStorageBackend {
  return createInternalStorageFeature({ userDataPath, scope: 'hosted-auth' });
}

export interface HttpServices {
  projectScanner: ProjectScanner;
  sessionParser: SessionParser;
  subagentResolver: SubagentResolver;
  chunkBuilder: ChunkBuilder;
  dataCache: DataCache;
  recentProjectsFeature?: RecentProjectsFeatureFacade;
  organizationsFeature?: OrganizationsFeatureFacade;
  tokenUsageFeature?: TokenUsageFeatureFacade;
  memberWorkSyncFeature?: MemberWorkSyncFeatureFacade;
  updaterService: UpdaterService;
  sshConnectionManager: SshConnectionManager;
  teamApis?: TeamHttpHandlerApis;
  teamDataApi?: TeamHttpDataApi;
  teamLifecycleReadHost?: TeamLifecycleReadHost;
  hostedAuth?: HostedAuthHttpFacade;
  hostedCoordinationEventRoutes?: HostedCoordinationEventRouteContribution;
  hostedDiagnosticsRoutes?: HostedDiagnosticsRouteContribution;
  hostedLifecycleCommandRoutes?: HostedLifecycleCommandRouteContribution;
  hostedTeamTaskBoardRoutes?: HostedTeamTaskBoardRouteContribution;
  hostedTeamMessageRoutes?: HostedTeamMessageRouteContribution;
}

export function registerHttpRoutes(
  app: FastifyInstance,
  services: HttpServices,
  sshModeSwitchCallback: (mode: 'local' | 'ssh') => Promise<void>
): void {
  const hostedCoordinationEventRoutes = services.hostedCoordinationEventRoutes;
  const hostedDiagnosticsRoutes = services.hostedDiagnosticsRoutes;
  const hostedLifecycleCommandRoutes = services.hostedLifecycleCommandRoutes;
  const hostedTaskBoardRoutes = services.hostedTeamTaskBoardRoutes;
  const hostedTeamMessageRoutes = services.hostedTeamMessageRoutes;
  if (
    hostedCoordinationEventRoutes !== undefined &&
    (typeof hostedCoordinationEventRoutes.register !== 'function' ||
      services.hostedAuth === undefined)
  ) {
    throw new Error('hosted_coordination_event_composition_invalid');
  }
  if (
    hostedDiagnosticsRoutes !== undefined &&
    (typeof hostedDiagnosticsRoutes.register !== 'function' || services.hostedAuth === undefined)
  ) {
    throw new Error('hosted_diagnostics_composition_invalid');
  }
  if (
    hostedLifecycleCommandRoutes !== undefined &&
    (typeof hostedLifecycleCommandRoutes.register !== 'function' ||
      services.hostedAuth === undefined)
  ) {
    throw new Error('hosted_lifecycle_command_composition_invalid');
  }
  if (
    hostedTaskBoardRoutes !== undefined &&
    (typeof hostedTaskBoardRoutes.register !== 'function' || services.hostedAuth === undefined)
  ) {
    throw new Error('hosted_task_board_composition_invalid');
  }
  if (
    hostedTeamMessageRoutes !== undefined &&
    (typeof hostedTeamMessageRoutes.register !== 'function' || services.hostedAuth === undefined)
  ) {
    throw new Error('hosted_team_message_composition_invalid');
  }

  services.hostedAuth?.register(app);
  hostedCoordinationEventRoutes?.register(app);
  hostedDiagnosticsRoutes?.register(app);
  hostedLifecycleCommandRoutes?.register(app);
  hostedTaskBoardRoutes?.register(app);
  hostedTeamMessageRoutes?.register(app);
  registerProjectRoutes(app, services);
  registerSessionRoutes(app, services);
  registerSearchRoutes(app, services);
  registerSubagentRoutes(app, services);
  if (services.teamDataApi || services.teamApis || services.teamLifecycleReadHost) {
    registerTeamRoutes(app, services);
  }
  registerNotificationRoutes(app);
  registerConfigRoutes(
    app,
    services.hostedAuth
      ? {
          projectWorkspaceId: (request, workspaceId) =>
            services.hostedAuth!.projectWorkspaceId(request, workspaceId),
        }
      : undefined
  );
  registerValidationRoutes(app);
  registerUtilityRoutes(app);
  registerSshRoutes(app, services.sshConnectionManager, sshModeSwitchCallback);
  registerUpdaterRoutes(app, services);
  if (services.recentProjectsFeature) {
    registerRecentProjectsHttp(
      app,
      services.recentProjectsFeature,
      services.hostedAuth
        ? (request, workspaceId) => services.hostedAuth!.projectWorkspaceId(request, workspaceId)
        : undefined
    );
  }
  if (services.organizationsFeature) {
    registerOrganizationsHttp(app, services.organizationsFeature);
  }
  if (services.tokenUsageFeature) {
    registerTokenUsageHttp(app, services.tokenUsageFeature);
  }
  registerEventRoutes(
    app,
    services.hostedAuth
      ? {
          authorize: (request) => services.hostedAuth!.isEventStreamAuthorized(request),
          project: (request, channel, data) =>
            services.hostedAuth!.projectEvent(request, channel, data),
        }
      : undefined
  );

  logger.info('All HTTP routes registered');
}
