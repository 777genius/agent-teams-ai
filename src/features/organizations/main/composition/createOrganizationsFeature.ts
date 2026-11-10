import {
  GetOrganizationMapUseCase,
  ManageOrganizationStructureUseCase,
  type NormalizedOrganizationMapRequest,
  type OrganizationsClockPort,
  type OrganizationsLoggerPort,
} from '../../core/application';
import { CrossTeamOrganizationAdapter } from '../adapters/output/CrossTeamOrganizationAdapter';
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
  moveOrganizationUnit(
    request: MoveOrganizationUnitRequest
  ): Promise<OrganizationStructurePayload>;
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
  teamDataService: TeamDataService;
  crossTeamService: CrossTeamService;
  logger: OrganizationsLoggerPort;
  clock?: OrganizationsClockPort;
}): OrganizationsFeatureFacade {
  const structureRepository = new JsonOrganizationStructureRepository(deps.logger);
  const teamDirectory = new TeamDirectoryOrganizationAdapter(deps.teamDataService);
  const clock = deps.clock ?? { now: () => Date.now() };
  const mapUseCase = new GetOrganizationMapUseCase({
    structure: structureRepository,
    teamDirectory,
    crossTeamMessages: new CrossTeamOrganizationAdapter(deps.crossTeamService, deps.logger),
    clock,
    logger: deps.logger,
  });
  const structureUseCase = new ManageOrganizationStructureUseCase({
    structure: structureRepository,
    teamDirectory,
    clock,
    logger: deps.logger,
  });

  return {
    getOrganizationMap: (request) => mapUseCase.execute(request),
    getOrganizationStructure: (request) => structureUseCase.getStructure(request),
    createOrganization: (request) => structureUseCase.createOrganization(request),
    upsertOrganizationUnit: (request) => structureUseCase.upsertUnit(request),
    moveOrganizationUnit: (request) => structureUseCase.moveUnit(request),
    removeOrganizationUnit: (request) => structureUseCase.removeUnit(request),
    assignTeamToUnit: (request) => structureUseCase.assignTeam(request),
    removeTeamFromOrganization: (request) => structureUseCase.removeTeam(request),
    upsertOrganizationRelation: (request) => structureUseCase.upsertRelation(request),
    deleteOrganizationRelation: (request) => structureUseCase.deleteRelation(request),
  };
}
