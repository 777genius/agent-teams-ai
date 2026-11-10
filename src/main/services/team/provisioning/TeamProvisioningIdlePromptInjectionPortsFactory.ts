import { isLeadMember } from '@shared/utils/leadDetection';

import { TeamTaskReader } from '../TeamTaskReader';

import {
  injectGeminiPostLaunchHydration,
  injectPostCompactReminder,
  type TeamProvisioningIdlePromptInjectionConfig,
  type TeamProvisioningIdlePromptInjectionLogger,
  type TeamProvisioningIdlePromptInjectionPorts,
  type TeamProvisioningIdlePromptInjectionRun,
} from './TeamProvisioningIdlePromptInjection';
import {
  buildGeminiPostLaunchHydrationPrompt,
  buildPersistentLeadContext,
  buildTaskBoardSnapshot,
  type TeamProvisioningHydrationRun,
} from './TeamProvisioningPromptBuilders';
import { getPromptSizeSummary } from './TeamProvisioningRuntimeDiagnostics';

export type TeamProvisioningIdlePromptInjectionPortsFactoryRun =
  TeamProvisioningIdlePromptInjectionRun &
    TeamProvisioningHydrationRun & {
      child:
        | {
            stdin?: {
              writable?: boolean;
              write(payload: string, callback: (err?: Error | null) => void): unknown;
            } | null;
          }
        | null
        | undefined;
    };

export interface TeamProvisioningIdlePromptInjectionServiceAdapter<
  TRun extends TeamProvisioningIdlePromptInjectionPortsFactoryRun,
> {
  readConfigForObservation(
    teamName: string
  ): Promise<TeamProvisioningIdlePromptInjectionConfig | null | undefined>;
  setLeadActivity: TeamProvisioningIdlePromptInjectionPorts<TRun>['setLeadActivity'];
  resetRuntimeToolActivity: TeamProvisioningIdlePromptInjectionPorts<TRun>['resetRuntimeToolActivity'];
  getRunLeadName: TeamProvisioningIdlePromptInjectionPorts<TRun>['getRunLeadName'];
}

export interface TeamProvisioningIdlePromptInjectionPortsFactoryDeps<
  TRun extends TeamProvisioningIdlePromptInjectionPortsFactoryRun,
> {
  logger: TeamProvisioningIdlePromptInjectionLogger;
  service: TeamProvisioningIdlePromptInjectionServiceAdapter<TRun>;
  readTasks?: TeamProvisioningIdlePromptInjectionPorts<TRun>['readTasks'];
  isLeadMember?: TeamProvisioningIdlePromptInjectionPorts<TRun>['isLeadMember'];
  buildPersistentLeadContext?: TeamProvisioningIdlePromptInjectionPorts<TRun>['buildPersistentLeadContext'];
  buildTaskBoardSnapshot?: TeamProvisioningIdlePromptInjectionPorts<TRun>['buildTaskBoardSnapshot'];
  buildGeminiPostLaunchHydrationPrompt?: TeamProvisioningIdlePromptInjectionPorts<TRun>['buildGeminiPostLaunchHydrationPrompt'];
  getPromptSizeSummary?: TeamProvisioningIdlePromptInjectionPorts<TRun>['getPromptSizeSummary'];
  writeLeadStdin?: TeamProvisioningIdlePromptInjectionPorts<TRun>['writeLeadStdin'];
}

export interface TeamProvisioningIdlePromptInjectionServiceHost<
  TRun extends TeamProvisioningIdlePromptInjectionPortsFactoryRun,
> {
  configFacade: {
    readConfigForObservation: TeamProvisioningIdlePromptInjectionServiceAdapter<TRun>['readConfigForObservation'];
  };
  setLeadActivity: TeamProvisioningIdlePromptInjectionServiceAdapter<TRun>['setLeadActivity'];
  resetRuntimeToolActivity: TeamProvisioningIdlePromptInjectionServiceAdapter<TRun>['resetRuntimeToolActivity'];
  getRunLeadName: TeamProvisioningIdlePromptInjectionServiceAdapter<TRun>['getRunLeadName'];
}

export interface TeamProvisioningIdlePromptInjectionServiceHostOptions {
  logger: TeamProvisioningIdlePromptInjectionLogger;
}

export interface TeamProvisioningIdlePromptInjectionBoundary<
  TRun extends TeamProvisioningIdlePromptInjectionPortsFactoryRun,
> {
  injectPostCompactReminder(run: TRun): Promise<void>;
  injectGeminiPostLaunchHydration(run: TRun): Promise<void>;
}

function writeLeadStdin<TRun extends TeamProvisioningIdlePromptInjectionPortsFactoryRun>(
  run: TRun,
  payload: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    run.child!.stdin!.write(`${payload}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function createTeamProvisioningIdlePromptInjectionPorts<
  TRun extends TeamProvisioningIdlePromptInjectionPortsFactoryRun,
>(
  deps: TeamProvisioningIdlePromptInjectionPortsFactoryDeps<TRun>
): TeamProvisioningIdlePromptInjectionPorts<TRun> {
  return {
    logger: deps.logger,
    readConfigForObservation: (teamName) => deps.service.readConfigForObservation(teamName),
    readTasks: deps.readTasks ?? ((teamName) => new TeamTaskReader().getTasks(teamName)),
    isLeadMember: deps.isLeadMember ?? isLeadMember,
    buildPersistentLeadContext: deps.buildPersistentLeadContext ?? buildPersistentLeadContext,
    buildTaskBoardSnapshot: deps.buildTaskBoardSnapshot ?? buildTaskBoardSnapshot,
    buildGeminiPostLaunchHydrationPrompt:
      deps.buildGeminiPostLaunchHydrationPrompt ?? buildGeminiPostLaunchHydrationPrompt,
    getPromptSizeSummary: deps.getPromptSizeSummary ?? getPromptSizeSummary,
    writeLeadStdin: deps.writeLeadStdin ?? writeLeadStdin,
    setLeadActivity: (run, state) => deps.service.setLeadActivity(run, state),
    resetRuntimeToolActivity: (run, memberName) =>
      deps.service.resetRuntimeToolActivity(run, memberName),
    getRunLeadName: (run) => deps.service.getRunLeadName(run),
  };
}

export function createTeamProvisioningIdlePromptInjectionBoundary<
  TRun extends TeamProvisioningIdlePromptInjectionPortsFactoryRun,
>(
  deps: TeamProvisioningIdlePromptInjectionPortsFactoryDeps<TRun>
): TeamProvisioningIdlePromptInjectionBoundary<TRun> {
  const ports = createTeamProvisioningIdlePromptInjectionPorts(deps);

  return {
    injectPostCompactReminder: (run) => injectPostCompactReminder(run, ports),
    injectGeminiPostLaunchHydration: (run) => injectGeminiPostLaunchHydration(run, ports),
  };
}

export function createTeamProvisioningIdlePromptInjectionDepsFromService<
  TRun extends TeamProvisioningIdlePromptInjectionPortsFactoryRun,
>(
  service: TeamProvisioningIdlePromptInjectionServiceHost<TRun>,
  options: TeamProvisioningIdlePromptInjectionServiceHostOptions
): TeamProvisioningIdlePromptInjectionPortsFactoryDeps<TRun> {
  return {
    logger: options.logger,
    service: {
      readConfigForObservation: (teamName) =>
        service.configFacade.readConfigForObservation(teamName),
      setLeadActivity: (run, state) => service.setLeadActivity(run, state),
      resetRuntimeToolActivity: (run, memberName) =>
        service.resetRuntimeToolActivity(run, memberName),
      getRunLeadName: (run) => service.getRunLeadName(run),
    },
  };
}

export function createTeamProvisioningIdlePromptInjectionBoundaryFromService<
  TRun extends TeamProvisioningIdlePromptInjectionPortsFactoryRun,
>(
  service: TeamProvisioningIdlePromptInjectionServiceHost<TRun>,
  options: TeamProvisioningIdlePromptInjectionServiceHostOptions
): TeamProvisioningIdlePromptInjectionBoundary<TRun> {
  return createTeamProvisioningIdlePromptInjectionBoundary<TRun>(
    createTeamProvisioningIdlePromptInjectionDepsFromService(service, options)
  );
}
