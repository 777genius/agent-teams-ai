import {
  buildAllOrganizationsGraph,
  buildOrganizationGraph,
  getAllScopeOrganizationNodeId,
  getOrganizationNodeId,
  type OrgNodeModel,
  type OrgRelationModel,
  type OrgStructureModel,
  type OrgTeamCandidate,
  projectCrossTeamRelations,
} from '../domain';

import type {
  OrganizationMapPayload,
  OrganizationMapRequest,
  OrganizationMapScope,
  OrganizationNodeDto,
  OrganizationRelationDto,
} from '../../contracts';
import type {
  OrganizationsClockPort,
  OrganizationsCrossTeamMessagePort,
  OrganizationsLoggerPort,
  OrganizationsStructurePort,
  OrganizationsTeamDirectoryPort,
} from './ports';

export type NormalizedOrganizationMapRequest = Required<
  Omit<OrganizationMapRequest, 'organizationId' | 'scope'>
> & {
  organizationId?: string;
  scope: OrganizationMapScope;
};

export interface GetOrganizationMapUseCaseDeps {
  structure: OrganizationsStructurePort;
  teamDirectory: OrganizationsTeamDirectoryPort;
  crossTeamMessages: OrganizationsCrossTeamMessagePort;
  clock: OrganizationsClockPort;
  logger: OrganizationsLoggerPort;
}

function toNodeDto(node: OrgNodeModel): OrganizationNodeDto {
  return {
    id: node.id,
    structureUnitId: node.structureUnitId,
    kind: node.kind,
    label: node.label,
    description: node.description,
    color: node.color,
    parentNodeId: node.parentNodeId,
    title: node.title,
    tags: node.tags,
    team: node.team
      ? {
          teamName: node.team.teamName,
          displayName: node.team.displayName,
          description: node.team.description,
          color: node.team.color,
          projectPath: node.team.projectPath,
          isOnline: node.team.isOnline,
          memberCount: node.team.memberCount,
          taskCounts: node.team.taskCounts,
          agents: node.team.agents.map((agent) => ({
            id: agent.id,
            teamName: agent.teamName,
            name: agent.name,
            role: agent.role,
            color: agent.color,
            status: agent.status,
            currentTasks: agent.currentTasks,
            activeTaskCount: agent.activeTaskCount,
          })),
          truncatedAgents: node.team.truncatedAgents || undefined,
        }
      : undefined,
  };
}

function toRelationDto(relation: OrgRelationModel): OrganizationRelationDto {
  return {
    id: relation.id,
    sourceNodeId: relation.sourceNodeId,
    targetNodeId: relation.targetNodeId,
    kind: relation.kind,
    sourceKind: relation.sourceKind,
    weight: relation.weight,
    messageCount: relation.messageCount,
    lastActivityAt: relation.lastActivityAt,
    label: relation.label,
    latestMessagePreview: relation.latestMessagePreview,
  };
}

function getNormalizedOrganizationRootNodeId(organization: {
  id: string;
  rootNodeId: string;
}): string {
  return organization.rootNodeId.startsWith('org:')
    ? organization.rootNodeId
    : getOrganizationNodeId(organization.rootNodeId || organization.id);
}

function getActiveOrganizationId(params: {
  structure: OrgStructureModel | null;
  requestedOrganizationId: string | undefined;
  fallbackOrganizationId: string;
}): string {
  const requested = params.requestedOrganizationId;
  if (
    requested &&
    params.structure?.organizations.some((organization) => organization.id === requested)
  ) {
    return requested;
  }
  return params.structure?.organizations[0]?.id ?? params.fallbackOrganizationId;
}

export class GetOrganizationMapUseCase {
  constructor(private readonly deps: GetOrganizationMapUseCaseDeps) {}

  async execute(request: NormalizedOrganizationMapRequest): Promise<OrganizationMapPayload> {
    const generatedAt = new Date(this.deps.clock.now()).toISOString();
    const warnings: string[] = [];
    let degraded = false;

    let teams: OrgTeamCandidate[] = [];
    let structure: OrgStructureModel | null = null;
    try {
      teams = await this.deps.teamDirectory.listTeams({
        includeDeletedTeams: request.includeDeletedTeams,
      });
    } catch (error) {
      degraded = true;
      warnings.push('Failed to load teams.');
      this.deps.logger.error('organizations team directory failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      structure = await this.deps.structure.loadStructure({
        organizationId: request.organizationId,
      });
    } catch (error) {
      degraded = true;
      warnings.push('Failed to load configured organization structure.');
      this.deps.logger.warn('organizations structure failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const scope = request.scope === 'all' ? 'all' : 'organization';
    const graphInput = {
      organizationId: request.organizationId,
      organizationName: 'All Teams',
      structure,
      teams,
      maxTeams: request.maxTeams,
      maxAgentsPerTeam: request.maxAgentsPerTeam,
      maxTasksPerAgent: request.maxTasksPerAgent,
      generatedAt,
    };
    const graph =
      scope === 'all' ? buildAllOrganizationsGraph(graphInput) : buildOrganizationGraph(graphInput);
    warnings.push(...graph.warnings);

    let communicationRelations: OrgRelationModel[] = [];
    let totalCrossTeamMessages = 0;
    let truncatedCrossTeamMessages = 0;

    try {
      const messages = await this.deps.crossTeamMessages.listRecentMessages({
        teamNames: graph.renderedTeamNames,
        maxMessages: request.maxCrossTeamMessages,
      });
      const projected = projectCrossTeamRelations({
        messages,
        visibleTeamNames: new Set(graph.renderedTeamNames),
        maxMessages: request.maxCrossTeamMessages,
      });
      communicationRelations = projected.relations;
      totalCrossTeamMessages = projected.totalMessages;
      truncatedCrossTeamMessages = projected.truncatedMessages;
    } catch (error) {
      degraded = true;
      warnings.push('Failed to load cross-team communication.');
      this.deps.logger.warn('organizations cross-team messages failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const nodes = graph.nodes.map(toNodeDto);
    const relations = [...graph.relations, ...communicationRelations].map(toRelationDto);
    const activeOrganizationId = getActiveOrganizationId({
      structure,
      requestedOrganizationId: request.organizationId,
      fallbackOrganizationId: graph.organization.id,
    });
    const organizations =
      structure && structure.organizations.length > 0
        ? structure.organizations.map((organization) =>
            scope === 'all'
              ? {
                  id: organization.id,
                  name: organization.name,
                  description: organization.description,
                  rootNodeId: getAllScopeOrganizationNodeId(organization.id),
                  parentOrganizationId: organization.parentOrganizationId ?? null,
                  updatedAt: organization.updatedAt,
                }
              : organization.id === graph.organization.id
                ? {
                    id: graph.organization.id,
                    name: graph.organization.name,
                    description: graph.organization.description,
                    rootNodeId: graph.organization.rootNodeId,
                    parentOrganizationId: graph.organization.parentOrganizationId ?? null,
                    updatedAt: graph.organization.updatedAt,
                  }
                : {
                    id: organization.id,
                    name: organization.name,
                    description: organization.description,
                    rootNodeId: getNormalizedOrganizationRootNodeId(organization),
                    parentOrganizationId: organization.parentOrganizationId ?? null,
                    updatedAt: organization.updatedAt,
                  }
          )
        : [
            {
              id: graph.organization.id,
              name: graph.organization.name,
              description: graph.organization.description,
              rootNodeId: graph.organization.rootNodeId,
              parentOrganizationId: graph.organization.parentOrganizationId ?? null,
              updatedAt: graph.organization.updatedAt,
            },
          ];

    return {
      scope,
      organizations,
      activeOrganizationId,
      rootNodeId: graph.organization.rootNodeId,
      nodes,
      relations,
      degraded,
      diagnostics: {
        totalTeams: teams.length,
        renderedTeams: graph.renderedTeamNames.length,
        totalCrossTeamMessages,
        renderedCrossTeamRelations: communicationRelations.length,
        truncatedTeams: graph.truncatedTeams,
        truncatedCrossTeamMessages,
        generatedAt,
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    };
  }
}
