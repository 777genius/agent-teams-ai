import {
  assignTeamToUnit,
  buildDefaultOrganizationStructure,
  createOrganization,
  deleteOrganizationRelation,
  ensureOrganizationStructureRoots,
  moveOrganizationUnit,
  normalizeOrganizationId,
  type OrgRelationDefinitionModel,
  type OrgStructureModel,
  type OrgSummaryModel,
  type OrgTeamCandidate,
  type OrgUnitModel,
  removeOrganizationUnit,
  removeTeamFromOrganization,
  upsertOrganizationRelation,
  upsertOrganizationUnit,
} from '../domain';

import type {
  AssignOrganizationTeamRequest,
  CreateOrganizationRequest,
  DeleteOrganizationRelationRequest,
  MoveOrganizationUnitRequest,
  OrganizationAvailableTeamDto,
  OrganizationMapRequest,
  OrganizationStructurePayload,
  OrganizationStructureRelationDto,
  OrganizationStructureSource,
  OrganizationStructureUnitDto,
  RemoveOrganizationTeamRequest,
  RemoveOrganizationUnitRequest,
  UpsertOrganizationRelationRequest,
  UpsertOrganizationUnitRequest,
} from '../../contracts';
import type {
  OrganizationsClockPort,
  OrganizationsLoggerPort,
  OrganizationsStructurePort,
  OrganizationsTeamDirectoryPort,
} from './ports';

export type OrganizationStructureRequest = Pick<OrganizationMapRequest, 'organizationId'>;

export interface ManageOrganizationStructureUseCaseDeps {
  structure: OrganizationsStructurePort;
  teamDirectory: OrganizationsTeamDirectoryPort;
  clock: OrganizationsClockPort;
  logger: OrganizationsLoggerPort;
}

function toUnitDto(unit: OrgUnitModel): OrganizationStructureUnitDto {
  return {
    id: unit.id,
    organizationId: unit.organizationId,
    parentId: unit.parentId,
    kind: unit.kind,
    label: unit.label,
    description: unit.description,
    color: unit.color,
    teamName: unit.teamName,
    title: unit.title,
    tags: unit.tags,
  };
}

function toRelationDto(relation: OrgRelationDefinitionModel): OrganizationStructureRelationDto {
  return {
    id: relation.id,
    organizationId: relation.organizationId,
    sourceNodeId: relation.sourceNodeId,
    targetNodeId: relation.targetNodeId,
    kind: relation.kind,
    sourceKind: relation.sourceKind,
    weight: relation.weight,
    label: relation.label,
  };
}

function toAvailableTeamDto(team: OrgTeamCandidate): OrganizationAvailableTeamDto {
  return {
    teamName: team.teamName,
    displayName: team.displayName,
    description: team.description,
    color: team.color,
    projectPath: team.projectPath,
    isOnline: team.isOnline,
  };
}

function selectActiveOrganization(
  organizations: readonly OrgSummaryModel[],
  requestedOrganizationId: string | undefined
): OrgSummaryModel | undefined {
  return (
    organizations.find((organization) => organization.id === requestedOrganizationId) ??
    organizations[0]
  );
}

export class ManageOrganizationStructureUseCase {
  constructor(private readonly deps: ManageOrganizationStructureUseCaseDeps) {}

  async getStructure(
    request: OrganizationStructureRequest = {}
  ): Promise<OrganizationStructurePayload> {
    const { structure, source, teams } = await this.loadEditableStructure(request);
    return this.toPayload(structure, source, teams, request.organizationId);
  }

  async createOrganization(
    request: CreateOrganizationRequest
  ): Promise<OrganizationStructurePayload> {
    const createdOrganizationId = normalizeOrganizationId(
      request.id ?? request.name,
      'organization'
    );
    const { structure, source, teams } = await this.loadEditableStructure({});
    const updatedAt = new Date(this.deps.clock.now()).toISOString();
    const editableStructure =
      source === 'generated' && !request.parentOrganizationId
        ? { organizations: [], units: [], relations: [], updatedAt }
        : structure;
    const nextStructure = createOrganization(editableStructure, {
      ...request,
      updatedAt,
    });
    const saved = await this.deps.structure.saveStructure(nextStructure);
    return this.toPayload(saved, 'configured', teams, createdOrganizationId);
  }

  async upsertUnit(request: UpsertOrganizationUnitRequest): Promise<OrganizationStructurePayload> {
    return this.mutate({ organizationId: request.organizationId }, (structure, updatedAt) =>
      upsertOrganizationUnit(structure, {
        ...request,
        updatedAt,
      })
    );
  }

  async moveUnit(request: MoveOrganizationUnitRequest): Promise<OrganizationStructurePayload> {
    return this.mutate({ organizationId: request.organizationId }, (structure, updatedAt) =>
      moveOrganizationUnit(structure, {
        ...request,
        updatedAt,
      })
    );
  }

  async removeUnit(request: RemoveOrganizationUnitRequest): Promise<OrganizationStructurePayload> {
    return this.mutate({ organizationId: request.organizationId }, (structure, updatedAt) =>
      removeOrganizationUnit(structure, {
        ...request,
        updatedAt,
      })
    );
  }

  async assignTeam(request: AssignOrganizationTeamRequest): Promise<OrganizationStructurePayload> {
    return this.mutate({ organizationId: request.organizationId }, (structure, updatedAt) =>
      assignTeamToUnit(structure, {
        ...request,
        updatedAt,
      })
    );
  }

  async removeTeam(request: RemoveOrganizationTeamRequest): Promise<OrganizationStructurePayload> {
    return this.mutate({ organizationId: request.organizationId }, (structure, updatedAt) =>
      removeTeamFromOrganization(structure, {
        ...request,
        updatedAt,
      })
    );
  }

  async upsertRelation(
    request: UpsertOrganizationRelationRequest
  ): Promise<OrganizationStructurePayload> {
    return this.mutate({ organizationId: request.organizationId }, (structure, updatedAt) =>
      upsertOrganizationRelation(structure, {
        ...request,
        updatedAt,
      })
    );
  }

  async deleteRelation(
    request: DeleteOrganizationRelationRequest
  ): Promise<OrganizationStructurePayload> {
    return this.mutate({ organizationId: request.organizationId }, (structure, updatedAt) =>
      deleteOrganizationRelation(structure, {
        ...request,
        updatedAt,
      })
    );
  }

  private async mutate(
    request: OrganizationStructureRequest,
    mutateStructure: (structure: OrgStructureModel, updatedAt: string) => OrgStructureModel
  ): Promise<OrganizationStructurePayload> {
    const { structure, teams } = await this.loadEditableStructure(request);
    const updatedAt = new Date(this.deps.clock.now()).toISOString();
    const nextStructure = mutateStructure(structure, updatedAt);
    const saved = await this.deps.structure.saveStructure(nextStructure);
    return this.toPayload(saved, 'configured', teams, request.organizationId);
  }

  private async loadEditableStructure(request: OrganizationStructureRequest): Promise<{
    structure: OrgStructureModel;
    source: OrganizationStructureSource;
    teams: OrgTeamCandidate[];
  }> {
    const teams = await this.deps.teamDirectory.listTeams({ includeDeletedTeams: false });
    const loaded = await this.deps.structure.loadStructure({
      organizationId: request.organizationId,
    });
    if (loaded) {
      const generatedAt = new Date(this.deps.clock.now()).toISOString();
      return {
        structure: ensureOrganizationStructureRoots(loaded, generatedAt),
        source: 'configured',
        teams,
      };
    }

    const generatedAt = new Date(this.deps.clock.now()).toISOString();
    return {
      structure: buildDefaultOrganizationStructure({
        teams,
        generatedAt,
        organizationId: request.organizationId,
        organizationName: 'All Teams',
      }),
      source: 'generated',
      teams,
    };
  }

  private toPayload(
    structure: OrgStructureModel,
    source: OrganizationStructureSource,
    teams: readonly OrgTeamCandidate[],
    requestedOrganizationId: string | undefined
  ): OrganizationStructurePayload {
    const activeOrganization = selectActiveOrganization(
      structure.organizations,
      requestedOrganizationId
    );
    if (!activeOrganization) {
      this.deps.logger.warn('organizations structure has no organizations');
    }

    return {
      organizations: structure.organizations,
      activeOrganizationId: activeOrganization?.id ?? 'default',
      units: structure.units.map(toUnitDto),
      relations: (structure.relations ?? []).map(toRelationDto),
      availableTeams: teams.map(toAvailableTeamDto),
      source,
      updatedAt: structure.updatedAt,
    };
  }
}
