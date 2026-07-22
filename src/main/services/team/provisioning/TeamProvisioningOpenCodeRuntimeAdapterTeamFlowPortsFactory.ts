import {
  getTasksBasePath as getDefaultTasksBasePath,
  getTeamsBasePath as getDefaultTeamsBasePath,
} from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { TeamTaskReader } from '../TeamTaskReader';

import { ensureCwdExists as defaultEnsureCwdExists } from './TeamProvisioningAsyncUtils';
import { type OpenCodeRuntimeAdapterTeamFlowPorts } from './TeamProvisioningOpenCodeRuntimeAdapterTeamFlow';
import { buildDeterministicLaunchHydrationPrompt as defaultBuildDeterministicLaunchHydrationPrompt } from './TeamProvisioningPromptBuilders';
import { tryReadRegularFileUtf8 as defaultReadRegularFileUtf8 } from './TeamProvisioningRegularFileRead';
import { TEAM_CONFIG_MAX_BYTES, TEAM_JSON_READ_TIMEOUT_MS } from './TeamProvisioningRunModel';
import { getTeamsBasePathsToProbe as getDefaultTeamsBasePathsToProbe } from './TeamProvisioningRuntimeLaunchSelection';

export interface TeamProvisioningOpenCodeRuntimeAdapterTeamFlowServiceHost {
  pathExists: OpenCodeRuntimeAdapterTeamFlowPorts['pathExists'];
  teamMetaStore: {
    writeMeta: OpenCodeRuntimeAdapterTeamFlowPorts['writeTeamMeta'];
  };
  membersMetaStore: {
    writeMembers: OpenCodeRuntimeAdapterTeamFlowPorts['writeMembersMeta'];
  };
  writeOpenCodeTeamConfig: OpenCodeRuntimeAdapterTeamFlowPorts['writeOpenCodeTeamConfig'];
  prepareFacade: {
    prepareOpenCodeRuntimeAdapterLaunch: OpenCodeRuntimeAdapterTeamFlowPorts['prepareOpenCodeRuntimeAdapterLaunch'];
  };
  resolveLaunchExpectedMembers: OpenCodeRuntimeAdapterTeamFlowPorts['resolveLaunchExpectedMembers'];
  updateConfigProjectPath: OpenCodeRuntimeAdapterTeamFlowPorts['updateConfigProjectPath'];
  runOpenCodeWorktreeRootAggregateLaunch: OpenCodeRuntimeAdapterTeamFlowPorts['runOpenCodeWorktreeRootAggregateLaunch'];
  runOpenCodeTeamRuntimeAdapterLaunch: OpenCodeRuntimeAdapterTeamFlowPorts['runOpenCodeTeamRuntimeAdapterLaunch'];
}

export interface TeamProvisioningOpenCodeRuntimeAdapterTeamFlowFactoryDeps {
  getTeamsBasePathsToProbe?: OpenCodeRuntimeAdapterTeamFlowPorts['getTeamsBasePathsToProbe'];
  getTeamsBasePath?: OpenCodeRuntimeAdapterTeamFlowPorts['getTeamsBasePath'];
  getTasksBasePath?: OpenCodeRuntimeAdapterTeamFlowPorts['getTasksBasePath'];
  ensureCwdExists?: OpenCodeRuntimeAdapterTeamFlowPorts['ensureCwdExists'];
  mkdir?: OpenCodeRuntimeAdapterTeamFlowPorts['mkdir'];
  nowMs?: OpenCodeRuntimeAdapterTeamFlowPorts['nowMs'];
  readRegularFileUtf8?: typeof defaultReadRegularFileUtf8;
  readExistingTasks?: OpenCodeRuntimeAdapterTeamFlowPorts['readExistingTasks'];
  warn?: OpenCodeRuntimeAdapterTeamFlowPorts['warn'];
  buildDeterministicLaunchHydrationPrompt?: OpenCodeRuntimeAdapterTeamFlowPorts['buildDeterministicLaunchHydrationPrompt'];
}

export function createOpenCodeRuntimeAdapterTeamFlowPortsFromService(
  service: TeamProvisioningOpenCodeRuntimeAdapterTeamFlowServiceHost,
  deps: TeamProvisioningOpenCodeRuntimeAdapterTeamFlowFactoryDeps = {}
): OpenCodeRuntimeAdapterTeamFlowPorts {
  const getTeamsBasePath = deps.getTeamsBasePath ?? getDefaultTeamsBasePath;
  const readRegularFileUtf8 = deps.readRegularFileUtf8 ?? defaultReadRegularFileUtf8;

  return {
    getTeamsBasePathsToProbe: deps.getTeamsBasePathsToProbe ?? getDefaultTeamsBasePathsToProbe,
    getTeamsBasePath,
    getTasksBasePath: deps.getTasksBasePath ?? getDefaultTasksBasePath,
    pathExists: (filePath) => service.pathExists(filePath),
    ensureCwdExists: deps.ensureCwdExists ?? defaultEnsureCwdExists,
    mkdir:
      deps.mkdir ??
      (async (directoryPath) => {
        await fs.promises.mkdir(directoryPath, { recursive: true });
      }),
    nowMs: deps.nowMs ?? (() => Date.now()),
    writeTeamMeta: (teamName, data) => service.teamMetaStore.writeMeta(teamName, data),
    writeMembersMeta: (teamName, members, options) =>
      service.membersMetaStore.writeMembers(teamName, members, options),
    writeOpenCodeTeamConfig: (launchRequest, members) =>
      service.writeOpenCodeTeamConfig(launchRequest, members),
    prepareOpenCodeRuntimeAdapterLaunch: (params) =>
      service.prepareFacade.prepareOpenCodeRuntimeAdapterLaunch(params),
    readTeamConfigRaw: (teamName) =>
      readRegularFileUtf8(path.join(getTeamsBasePath(), teamName, 'config.json'), {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      }),
    resolveLaunchExpectedMembers: (teamName, configRaw, leadProviderId) =>
      service.resolveLaunchExpectedMembers(teamName, configRaw, leadProviderId),
    updateConfigProjectPath: (teamName, cwd) => service.updateConfigProjectPath(teamName, cwd),
    readExistingTasks:
      deps.readExistingTasks ?? ((teamName) => new TeamTaskReader().getTasks(teamName)),
    warn: deps.warn ?? (() => undefined),
    buildDeterministicLaunchHydrationPrompt:
      deps.buildDeterministicLaunchHydrationPrompt ??
      defaultBuildDeterministicLaunchHydrationPrompt,
    runOpenCodeWorktreeRootAggregateLaunch: (input) =>
      service.runOpenCodeWorktreeRootAggregateLaunch(input),
    runOpenCodeTeamRuntimeAdapterLaunch: (input) =>
      service.runOpenCodeTeamRuntimeAdapterLaunch(input),
  };
}
