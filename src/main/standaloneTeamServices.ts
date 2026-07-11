import { createMemberWorkSyncFeature } from '@features/member-work-sync/main';
import { createLogger } from '@shared/utils/logger';

import {
  bindTeamHttpDataApi,
  bindTeamHttpHandlerApis,
} from './services/team/contracts/TeamProvisioningApis';
import { TeamConfigReader } from './services/team/TeamConfigReader';
import { TeamDataService } from './services/team/TeamDataService';
import { TeamKanbanManager } from './services/team/TeamKanbanManager';
import { TeamMembersMetaStore } from './services/team/TeamMembersMetaStore';
import { TeamProvisioningService } from './services/team/TeamProvisioningService';
import { TeamTaskReader } from './services/team/TeamTaskReader';
import { getTeamsBasePath } from './utils/pathDecoder';

import type { HttpServices } from './http';
import type {
  TeamHttpDataApi,
  TeamHttpHandlerApis,
  TeamHttpRuntimeApi,
  TeamProvisioningStartApi,
  TeamProvisioningStatusApi,
  TeamRuntimeControlCompatibilityApi,
  TeamTaskActivityRepairApi,
} from './services/team/contracts/TeamProvisioningApis';
import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type {
  RuntimeCoreTeamOrchestrationSource,
  RuntimeCoreTeamSources,
} from '@features/runtime-core/main';

export type StandaloneTeamProvisioningHttpApi = TeamProvisioningStartApi &
  TeamProvisioningStatusApi &
  TeamTaskActivityRepairApi &
  TeamHttpRuntimeApi &
  TeamRuntimeControlCompatibilityApi;

export interface StandaloneTeamHttpServiceSlice {
  teamDataApi: TeamHttpDataApi;
  teamApis: TeamHttpHandlerApis;
  memberWorkSyncFeature: MemberWorkSyncFeatureFacade;
}

export interface StandaloneTeamServices {
  teamDataService: TeamDataService;
  teamProvisioningService: TeamProvisioningService;
  memberWorkSyncFeature: MemberWorkSyncFeatureFacade;
  httpServices: StandaloneTeamHttpServiceSlice;
  runtimeCoreTeamSources: RuntimeCoreTeamSources;
  dispose(): Promise<void>;
}

export function buildStandaloneTeamHttpServiceSlice(input: {
  teamDataService: TeamHttpDataApi;
  teamProvisioningService: StandaloneTeamProvisioningHttpApi;
  memberWorkSyncFeature: MemberWorkSyncFeatureFacade;
}): StandaloneTeamHttpServiceSlice {
  return {
    teamDataApi: bindTeamHttpDataApi(input.teamDataService),
    teamApis: bindTeamHttpHandlerApis(input.teamProvisioningService),
    memberWorkSyncFeature: input.memberWorkSyncFeature,
  };
}

export function createStandaloneRuntimeCoreTeamSources(input: {
  teamDataService: TeamHttpDataApi;
  teamProvisioningService: RuntimeCoreTeamOrchestrationSource;
}): RuntimeCoreTeamSources {
  return {
    data: input.teamDataService,
    orchestration: input.teamProvisioningService,
  };
}

export function createStandaloneTeamServices(): StandaloneTeamServices {
  const teamDataService = new TeamDataService();
  const teamProvisioningService = new TeamProvisioningService();
  const memberWorkSyncFeature = createMemberWorkSyncFeature({
    teamsBasePath: getTeamsBasePath(),
    configReader: new TeamConfigReader(),
    taskReader: new TeamTaskReader(),
    kanbanManager: new TeamKanbanManager(),
    membersMetaStore: new TeamMembersMetaStore(),
    isTeamActive: (teamName) => teamProvisioningService.isTeamAlive(teamName),
    isMemberActive: ({ teamName }) => teamProvisioningService.isTeamAlive(teamName),
    canDispatchNudges: (teamName) => teamProvisioningService.isTeamAlive(teamName),
    listLifecycleActiveTeamNames: async () =>
      (await teamDataService.listTeams())
        .map((team) => team.teamName)
        .filter((teamName) => teamProvisioningService.isTeamAlive(teamName)),
    logger: createLogger('Feature:MemberWorkSync'),
  });

  teamProvisioningService.setRuntimeTurnSettledHookSettingsProvider((input) =>
    memberWorkSyncFeature.buildRuntimeTurnSettledHookSettings(input)
  );
  teamProvisioningService.setRuntimeTurnSettledEnvironmentProvider((input) =>
    memberWorkSyncFeature.buildRuntimeTurnSettledEnvironment(input)
  );
  teamProvisioningService.setMemberWorkSyncProofMissingRecoveryScheduler((input) =>
    memberWorkSyncFeature.scheduleProofMissingRecovery(input)
  );
  teamProvisioningService.setMemberWorkSyncAcceptedReportChecker(async (input) => {
    const status = await memberWorkSyncFeature.getStatus(input);
    const report = status.report;
    if (report?.accepted !== true || report.agendaFingerprint !== status.agenda.fingerprint) {
      return false;
    }
    if (report.state !== 'still_working' && report.state !== 'blocked') {
      return true;
    }
    const expiresAtMs = Date.parse(report.expiresAt ?? '');
    return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
  });

  return {
    teamDataService,
    teamProvisioningService,
    memberWorkSyncFeature,
    httpServices: buildStandaloneTeamHttpServiceSlice({
      teamDataService,
      teamProvisioningService,
      memberWorkSyncFeature,
    }),
    runtimeCoreTeamSources: createStandaloneRuntimeCoreTeamSources({
      teamDataService,
      teamProvisioningService,
    }),
    dispose: () => memberWorkSyncFeature.dispose(),
  };
}

export function attachStandaloneTeamHttpServices(
  services: HttpServices,
  standaloneTeamServices: Pick<StandaloneTeamServices, 'httpServices'>
): HttpServices {
  return {
    ...services,
    ...standaloneTeamServices.httpServices,
  };
}
