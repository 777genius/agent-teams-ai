import { projectTeamSummaries } from '@features/team-project-context/main';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

import {
  GetOrganizationMapUseCase,
  ManageOrganizationStructureUseCase,
  type NormalizedOrganizationMapRequest,
  type OrganizationsClockPort,
  type OrganizationsLoggerPort,
  type OrganizationsStructurePort,
} from '../../core/application';
import { CrossTeamOrganizationAdapter } from '../adapters/output/CrossTeamOrganizationAdapter';
import { HostRoutedOrganizationSource } from '../adapters/output/HostRoutedOrganizationSource';
import { TeamDirectoryOrganizationAdapter } from '../adapters/output/TeamDirectoryOrganizationAdapter';
import { JsonOrganizationStructureRepository } from '../infrastructure/JsonOrganizationStructureRepository';

import type {
  AssignOrganizationTeamRequest,
  CreateOrganizationRequest,
  DeleteOrganizationRelationRequest,
  MoveOrganizationUnitRequest,
  OrganizationMapPayload,
  OrganizationStructurePayload,
  RemoveOrganizationTeamRequest,
  RemoveOrganizationUnitRequest,
  UpsertOrganizationRelationRequest,
  UpsertOrganizationUnitRequest,
} from '../../contracts';
import type { CaptureHostTeamReads } from '@features/agent-backend/main';
import type { CrossTeamService } from '@main/services/team/CrossTeamService';
import type { TeamDataService } from '@main/services/team/TeamDataService';

export interface OrganizationsFeatureFacade {
  getOrganizationMap(request: NormalizedOrganizationMapRequest): Promise<OrganizationMapPayload>;
  getOrganizationStructure(
    request?: Pick<NormalizedOrganizationMapRequest, 'organizationId'>
  ): Promise<OrganizationStructurePayload>;
  createOrganization(request: CreateOrganizationRequest): Promise<OrganizationStructurePayload>;
  upsertOrganizationUnit(
    request: UpsertOrganizationUnitRequest
  ): Promise<OrganizationStructurePayload>;
  moveOrganizationUnit(request: MoveOrganizationUnitRequest): Promise<OrganizationStructurePayload>;
  removeOrganizationUnit(
    request: RemoveOrganizationUnitRequest
  ): Promise<OrganizationStructurePayload>;
  assignTeamToUnit(request: AssignOrganizationTeamRequest): Promise<OrganizationStructurePayload>;
  removeTeamFromOrganization(
    request: RemoveOrganizationTeamRequest
  ): Promise<OrganizationStructurePayload>;
  upsertOrganizationRelation(
    request: UpsertOrganizationRelationRequest
  ): Promise<OrganizationStructurePayload>;
  deleteOrganizationRelation(
    request: DeleteOrganizationRelationRequest
  ): Promise<OrganizationStructurePayload>;
}

export function createOrganizationsFeature(deps: {
  teamDataService: Pick<TeamDataService, 'listTeams' | 'getAllTasks' | 'listAliveProcessTeams'>;
  crossTeamService: Pick<CrossTeamService, 'getOutbox'>;
  captureHost?: CaptureHostTeamReads;
  logger: OrganizationsLoggerPort;
  clock?: OrganizationsClockPort;
}): OrganizationsFeatureFacade {
  const structureRepository = new JsonOrganizationStructureRepository(deps.logger);
  const teamDirectory = new TeamDirectoryOrganizationAdapter(deps.teamDataService, (teams) =>
    projectTeamSummaries(teams, new TeamMetaStore())
  );
  const clock = deps.clock ?? { now: () => Date.now() };
  const crossTeamMessages = new CrossTeamOrganizationAdapter(deps.crossTeamService, deps.logger);
  const useCases = (
    directory = teamDirectory,
    messages = crossTeamMessages,
    structure: OrganizationsStructurePort = structureRepository
  ) => ({
    map: new GetOrganizationMapUseCase({
      structure,
      teamDirectory: directory,
      crossTeamMessages: messages,
      clock,
      logger: deps.logger,
    }),
    structure: new ManageOrganizationStructureUseCase({
      structure,
      teamDirectory: directory,
      clock,
      logger: deps.logger,
    }),
  });
  const legacy = useCases();
  const captured = async <T>(
    operation: (value: ReturnType<typeof useCases>) => Promise<T>
  ): Promise<T> => {
    const host = await deps.captureHost?.();
    if (!host) return operation(legacy);
    const source = new HostRoutedOrganizationSource(host, teamDirectory, crossTeamMessages);
    source.assertCurrent();
    const structure: OrganizationsStructurePort = {
      async loadStructure() {
        source.assertCurrent();
        const value = await structureRepository.loadStructure();
        source.assertCurrent();
        return value;
      },
      async saveStructure(value) {
        source.assertCurrent();
        const result = await structureRepository.saveStructure(value);
        source.assertCurrent();
        return result;
      },
    };
    const result = await operation({
      map: new GetOrganizationMapUseCase({
        structure,
        teamDirectory: source,
        crossTeamMessages: source,
        clock,
        logger: deps.logger,
      }),
      structure: new ManageOrganizationStructureUseCase({
        structure,
        teamDirectory: source,
        clock,
        logger: deps.logger,
      }),
    });
    source.assertCurrent();
    return result;
  };
  return {
    getOrganizationMap: (request) => captured((value) => value.map.execute(request)),
    getOrganizationStructure: (request) =>
      captured((value) => value.structure.getStructure(request)),
    createOrganization: (request) =>
      captured((value) => value.structure.createOrganization(request)),
    upsertOrganizationUnit: (request) => captured((value) => value.structure.upsertUnit(request)),
    moveOrganizationUnit: (request) => captured((value) => value.structure.moveUnit(request)),
    removeOrganizationUnit: (request) => captured((value) => value.structure.removeUnit(request)),
    assignTeamToUnit: (request) => captured((value) => value.structure.assignTeam(request)),
    removeTeamFromOrganization: (request) =>
      captured((value) => value.structure.removeTeam(request)),
    upsertOrganizationRelation: (request) =>
      captured((value) => value.structure.upsertRelation(request)),
    deleteOrganizationRelation: (request) =>
      captured((value) => value.structure.deleteRelation(request)),
  };
}
