export type OrgNodeKind = 'organization' | 'container' | 'team';

export type OrgRelationKind =
  | 'contains'
  | 'communicates'
  | 'delegates'
  | 'depends_on'
  | 'observes'
  | (string & Record<never, never>);

export type OrgRelationSourceKind = 'manual' | 'inferred' | 'runtime';

export type OrgTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export type OrgAgentStatus = 'active' | 'idle' | 'offline' | 'unknown';

export interface OrgTaskModel {
  id: string;
  subject: string;
  status: OrgTaskStatus;
  updatedAt?: string;
  kanbanColumn?: string;
}

export interface OrgMemberCandidate {
  name: string;
  role?: string;
  color?: string;
}

export interface OrgTaskCandidate extends OrgTaskModel {
  owner: string | null | undefined;
}

export interface OrgTeamCandidate {
  teamName: string;
  displayName: string;
  description?: string;
  color?: string;
  projectPath?: string;
  isOnline: boolean;
  deletedAt?: string;
  pendingCreate?: boolean;
  members: OrgMemberCandidate[];
  tasks: OrgTaskCandidate[];
}

export interface OrgAgentModel {
  id: string;
  teamName: string;
  name: string;
  role?: string;
  color?: string;
  status: OrgAgentStatus;
  currentTasks: OrgTaskModel[];
  activeTaskCount: number;
}

export interface OrgTeamModel {
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
  agents: OrgAgentModel[];
  truncatedAgents: number;
}

export interface OrgNodeModel {
  id: string;
  structureUnitId?: string;
  kind: OrgNodeKind;
  label: string;
  description?: string;
  color?: string;
  parentNodeId?: string | null;
  title?: string;
  tags?: string[];
  team?: OrgTeamModel;
}

export interface OrgRelationModel {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: OrgRelationKind;
  sourceKind: OrgRelationSourceKind;
  weight: number;
  messageCount?: number;
  lastActivityAt?: string;
  label?: string;
  latestMessagePreview?: string;
}

export interface OrgSummaryModel {
  id: string;
  name: string;
  description?: string;
  rootNodeId: string;
  parentOrganizationId?: string | null;
  updatedAt?: string;
}

export interface OrgUnitModel {
  id: string;
  organizationId: string;
  parentId: string | null;
  kind: OrgNodeKind;
  label: string;
  description?: string;
  color?: string;
  teamName?: string;
  title?: string;
  tags?: string[];
}

export interface OrgRelationDefinitionModel {
  id?: string;
  organizationId?: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: OrgRelationKind;
  sourceKind: OrgRelationSourceKind;
  weight?: number;
  label?: string;
}

export interface OrgStructureModel {
  organizations: OrgSummaryModel[];
  units: OrgUnitModel[];
  relations?: OrgRelationDefinitionModel[];
  updatedAt?: string;
}

export interface CrossTeamMessageCandidate {
  messageId?: string;
  fromTeam: string;
  toTeam: string;
  text?: string;
  summary?: string;
  conversationId?: string;
  timestamp: string;
}
