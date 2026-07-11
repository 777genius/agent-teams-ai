import {
  bindTeamHttpDataApi,
  bindTeamHttpHandlerApis,
  bindTeamIpcHandlerApis,
  type TeamHttpDataApi,
  type TeamHttpHandlerApis,
  type TeamIpcHandlerApis,
} from '@main/services/team/contracts/TeamProvisioningApis';

import type {
  ChunkBuilder,
  DataCache,
  ProjectScanner,
  SessionParser,
  SubagentResolver,
} from '@main/services';

export interface RuntimeCoreProviderJsonParsingServices {
  projectScanner: ProjectScanner;
  sessionParser: SessionParser;
  subagentResolver: SubagentResolver;
  chunkBuilder: ChunkBuilder;
  dataCache: DataCache;
}

export type RuntimeCoreTeamOrchestrationSource = Parameters<typeof bindTeamIpcHandlerApis>[0] &
  Parameters<typeof bindTeamHttpHandlerApis>[0];

export interface RuntimeCoreTeamSources {
  data: TeamHttpDataApi;
  orchestration: RuntimeCoreTeamOrchestrationSource;
}

export interface RuntimeCoreTeamUseCases {
  data: TeamHttpDataApi;
  http: TeamHttpHandlerApis;
  ipc: TeamIpcHandlerApis;
}

export interface RuntimeCoreFeatureFacade {
  providerJsonParsing: RuntimeCoreProviderJsonParsingServices;
  teams?: RuntimeCoreTeamUseCases;
}

export interface CreateRuntimeCoreFeatureDeps {
  providerJsonParsing: RuntimeCoreProviderJsonParsingServices;
  teams?: RuntimeCoreTeamSources;
}

export function createRuntimeCoreProviderJsonParsingServices(
  source: RuntimeCoreProviderJsonParsingServices
): RuntimeCoreProviderJsonParsingServices {
  return {
    projectScanner: source.projectScanner,
    sessionParser: source.sessionParser,
    subagentResolver: source.subagentResolver,
    chunkBuilder: source.chunkBuilder,
    dataCache: source.dataCache,
  };
}

export function createRuntimeCoreTeamUseCases(
  sources: RuntimeCoreTeamSources
): RuntimeCoreTeamUseCases {
  return {
    data: bindTeamHttpDataApi(sources.data),
    http: bindTeamHttpHandlerApis(sources.orchestration),
    ipc: bindTeamIpcHandlerApis(sources.orchestration),
  };
}

export function createRuntimeCoreFeature(
  deps: CreateRuntimeCoreFeatureDeps
): RuntimeCoreFeatureFacade {
  return {
    providerJsonParsing: createRuntimeCoreProviderJsonParsingServices(deps.providerJsonParsing),
    ...(deps.teams ? { teams: createRuntimeCoreTeamUseCases(deps.teams) } : {}),
  };
}
