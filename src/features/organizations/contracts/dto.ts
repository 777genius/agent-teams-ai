export type OrganizationNodeKind = 'organization' | 'container' | 'team';

export type OrganizationRelationKind =
  | 'contains'
  | 'communicates'
  | 'delegates'
  | 'depends_on'
  | 'observes'
  | (string & Record<never, never>);

export type OrganizationRelationSourceKind = 'manual' | 'inferred' | 'runtime';

export type OrganizationAgentStatus = 'active' | 'idle' | 'offline' | 'unknown';

export type OrganizationMapScope = 'organization' | 'all';

export interface OrganizationMapRequest {
  scope?: OrganizationMapScope;
  organizationId?: string;
  includeDeletedTeams?: boolean;
  maxTeams?: number;
  maxAgentsPerTeam?: number;
  maxTasksPerAgent?: number;
  maxCrossTeamMessages?: number;
}

export interface OrganizationSummaryDto {
  id: string;
  name: string;
  description?: string;
  rootNodeId: string;
  parentOrganizationId?: string | null;
  updatedAt?: string;
}

export interface OrganizationAgentTaskDto {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  updatedAt?: string;
  kanbanColumn?: string;
}

export interface OrganizationAgentSummaryDto {
  id: string;
  teamName: string;
  name: string;
  role?: string;
  color?: string;
  status: OrganizationAgentStatus;
  currentTasks: OrganizationAgentTaskDto[];
  activeTaskCount: number;
}

export interface OrganizationTeamSummaryDto {
  teamName: string;
  displayName: string;
  description?: string;
  color?: string;
  projectPath?: string;
  isOnline: boolean;
  memberCount: number;
  taskCounts: {
    pending: number;
    inProgress: number;
    completed: number;
  };
  agents: OrganizationAgentSummaryDto[];
  truncatedAgents?: number;
}

export interface OrganizationNodeDto {
  id: string;
  structureUnitId?: string;
  kind: OrganizationNodeKind;
  label: string;
  description?: string;
  color?: string;
  parentNodeId?: string | null;
  title?: string;
  tags?: string[];
  team?: OrganizationTeamSummaryDto;
}

export interface OrganizationRelationDto {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: OrganizationRelationKind;
  sourceKind: OrganizationRelationSourceKind;
  weight: number;
  messageCount?: number;
  lastActivityAt?: string;
  label?: string;
  latestMessagePreview?: string;
}

export interface OrganizationMapDiagnosticsDto {
  totalTeams: number;
  renderedTeams: number;
  totalCrossTeamMessages: number;
  renderedCrossTeamRelations: number;
  truncatedTeams: number;
  truncatedCrossTeamMessages: number;
  generatedAt: string;
  warnings?: string[];
}

export interface OrganizationMapPayload {
  scope?: OrganizationMapScope;
  organizations: OrganizationSummaryDto[];
  activeOrganizationId: string;
  rootNodeId?: string;
  nodes: OrganizationNodeDto[];
  relations: OrganizationRelationDto[];
  degraded: boolean;
  diagnostics: OrganizationMapDiagnosticsDto;
}

export interface OrganizationStructureUnitDto {
  id: string;
  organizationId: string;
  parentId: string | null;
  kind: OrganizationNodeKind;
  label: string;
  description?: string;
  color?: string;
  teamName?: string;
  title?: string;
  tags?: string[];
}

export interface OrganizationStructureRelationDto {
  id?: string;
  organizationId?: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: OrganizationRelationKind;
  sourceKind: OrganizationRelationSourceKind;
  weight?: number;
  label?: string;
}

export interface OrganizationAvailableTeamDto {
  teamName: string;
  displayName: string;
  description?: string;
  color?: string;
  projectPath?: string;
  isOnline: boolean;
}

export type OrganizationStructureSource = 'configured' | 'generated';

export interface OrganizationStructurePayload {
  organizations: OrganizationSummaryDto[];
  activeOrganizationId: string;
  units: OrganizationStructureUnitDto[];
  relations: OrganizationStructureRelationDto[];
  availableTeams: OrganizationAvailableTeamDto[];
  source: OrganizationStructureSource;
  updatedAt?: string;
}

export interface CreateOrganizationRequest {
  id?: string;
  name: string;
  description?: string;
  parentOrganizationId?: string | null;
}

export interface UpsertOrganizationUnitRequest {
  organizationId: string;
  id?: string;
  parentId?: string | null;
  kind: 'container' | 'team';
  label: string;
  description?: string;
  color?: string;
  teamName?: string;
  title?: string;
  tags?: string[];
}

export interface MoveOrganizationUnitRequest {
  organizationId?: string;
  unitId: string;
  parentId: string | null;
}

export interface RemoveOrganizationUnitRequest {
  organizationId?: string;
  unitId: string;
  cascade?: boolean;
}

export interface AssignOrganizationTeamRequest {
  organizationId: string;
  parentUnitId: string;
  teamName: string;
  label?: string;
}

export interface OrganizationPlacementSelection {
  organizationId: string;
  parentUnitId: string;
}

export interface RemoveOrganizationTeamRequest {
  organizationId?: string;
  teamName: string;
}

export interface UpsertOrganizationRelationRequest {
  organizationId?: string;
  id?: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: OrganizationRelationKind;
  label?: string;
  weight?: number;
}

export interface DeleteOrganizationRelationRequest {
  organizationId?: string;
  relationId: string;
}
