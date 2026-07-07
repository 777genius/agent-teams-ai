/**
 * HTTP Route Registration Orchestrator.
 *
 * Registers all domain-specific route handlers on a Fastify instance.
 * Each route file mirrors the corresponding IPC handler.
 */

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
  TeamHttpProvisioningApis,
} from '../services/team/contracts/TeamProvisioningApis';
import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type { FastifyInstance } from 'fastify';

const logger = createLogger('HTTP:routes');

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
  teamDataApi?: TeamHttpDataApi;
  teamProvisioningApis?: TeamHttpProvisioningApis;
}

export function registerHttpRoutes(
  app: FastifyInstance,
  services: HttpServices,
  sshModeSwitchCallback: (mode: 'local' | 'ssh') => Promise<void>
): void {
  registerProjectRoutes(app, services);
  registerSessionRoutes(app, services);
  registerSearchRoutes(app, services);
  registerSubagentRoutes(app, services);
  if (services.teamDataApi || services.teamProvisioningApis) {
    registerTeamRoutes(app, services);
  }
  registerNotificationRoutes(app);
  registerConfigRoutes(app);
  registerValidationRoutes(app);
  registerUtilityRoutes(app);
  registerSshRoutes(app, services.sshConnectionManager, sshModeSwitchCallback);
  registerUpdaterRoutes(app, services);
  if (services.recentProjectsFeature) {
    registerRecentProjectsHttp(app, services.recentProjectsFeature);
  }
  if (services.organizationsFeature) {
    registerOrganizationsHttp(app, services.organizationsFeature);
  }
  if (services.tokenUsageFeature) {
    registerTokenUsageHttp(app, services.tokenUsageFeature);
  }
  registerEventRoutes(app);

  logger.info('All HTTP routes registered');
}
