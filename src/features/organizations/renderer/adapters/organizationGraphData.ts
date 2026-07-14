import type { OrganizationNodeDto, OrganizationRelationDto } from '../../contracts';
import type { OrganizationMapViewModel } from './organizationMapViewModel';
import type {
  GraphDataPort,
  GraphDomainRef,
  GraphEdge,
  GraphGroupFrame,
  GraphLayoutMode,
  GraphNode,
  GraphNodePosition,
  GraphNodeState,
  GraphOwnerSlotAssignment,
  GraphParticle,
} from '@claude-teams/agent-graph';

const MAX_PARTICLES_PER_RELATION = 3;
const MAX_PARTICLES_DETAILED_MAP = 96;
const MAX_PARTICLES_COMPACT_MAP = 48;
const MAX_ACTIVE_AGENT_TASKS_PER_TEAM = 4;
const COMPACT_LAYOUT_MAX_OWNER_COUNT = 10;
const ORGANIZATION_GRID_COMPACT_MAX_COLUMN_COUNT = 3;
const ORGANIZATION_GRID_MAX_COLUMN_COUNT = 12;
const ORGANIZATION_GRID_TOP_ROW_OFFSET = 0;
const ORGANIZATION_GRID_BLOCK_ROW_GAP = 0;
const ORGANIZATION_GRID_BLOCK_COLUMN_GAP = 0;
const ORGANIZATION_GRID_TOP_LEVEL_ORG_ROW_GAP = 1;
const ORGANIZATION_GRID_TOP_LEVEL_ORG_COLUMN_GAP = 1;
const ORGANIZATION_GRID_SIDE_BY_SIDE_MAX_BLOCK_WIDTH = 3;
const ORGANIZATION_GRID_SIDE_BY_SIDE_MAX_BLOCK_HEIGHT = 3;
const ORGANIZATION_GRID_SIDE_BY_SIDE_MAX_ROW_WIDTH = 7;
const ORGANIZATION_GRID_ALL_SCOPE_ORG_SECTION_MAX_BLOCKS_PER_ROW = 3;
const ORGANIZATION_GRID_ALL_SCOPE_ORG_SECTION_MAX_ROW_WIDTH = 30;
const ORGANIZATION_GRID_TOP_LEVEL_ORG_MAX_ROW_WIDTH = 40;
const SELECTIVE_AGENT_DETAILS_TEAM_THRESHOLD = 1;
const SELECTIVE_AGENT_DETAILS_AGENT_THRESHOLD = 60;
const SELECTIVE_AGENT_DETAILS_MESSAGE_THRESHOLD = 80;
const ALL_ORGANIZATIONS_ROOT_NODE_ID = 'org:__all-organizations__';
const HIERARCHY_HORIZONTAL_GAP = 292;
const HIERARCHY_VERTICAL_GAP = 164;
const HIERARCHY_ROOT_GAP_IN_LEAVES = 1;
const HIERARCHY_TASK_TOP_OFFSET = 112;
const HIERARCHY_TASK_VERTICAL_GAP = 86;

type OrganizationAgentDto = NonNullable<OrganizationNodeDto['team']>['agents'][number];
type OrganizationGraphDetailMode = 'active-agent-tasks' | 'hidden-agent-tasks';

export interface OrganizationGraphText {
  organizationMap: string;
  allOrganizations: string;
  unassignedTeams: string;
  agents: (count: number) => string;
  activeAgents: (count: number) => string;
  teams: (count: number) => string;
  orgsAndTeams: (orgCount: number, teamCount: number) => string;
  teamRole: (memberCount: number, activeCount: number) => string;
  groupSummary: (teamCount: number, activeTeamCount: number, taskCount: number) => string;
  teamSummary: (status: string, activeTaskCount: number, taskCount: number) => string;
  teamReference: string;
  notFound: string;
  online: string;
  offline: string;
  agentStatus: (status: OrganizationAgentDto['status']) => string;
}

export interface BuildOrganizationGraphDataOptions {
  collapsedNodeIds?: ReadonlySet<string>;
  layoutMode?: GraphLayoutMode;
  selectedNodeId?: string | null;
  showSelectedTeamDetails?: boolean;
  text?: OrganizationGraphText;
}

export interface OrganizationGraphRenderProfile {
  detailMode: OrganizationGraphDetailMode;
  layoutMode: GraphLayoutMode;
  selectedTeamNodeId: string | null;
  visibleTeamCount: number;
  visibleOrganizationNodeCount: number;
  renderedAgentCount: number;
  hiddenAgentCount: number;
  maxParticleCount: number;
}

interface OrganizationGraphBuildContext extends OrganizationGraphRenderProfile {
  visibleOrganizationNodeIds: Set<string>;
  collapsedVisibleContainerNodeIds: Set<string>;
  visibleTeamNodes: OrganizationNodeDto[];
  renderedAgentTeamIds: Set<string>;
  ownerOrder: string[];
}

const DEFAULT_ORGANIZATION_GRAPH_TEXT: OrganizationGraphText = {
  organizationMap: 'Organization Map',
  allOrganizations: 'All Organizations',
  unassignedTeams: 'Unassigned Teams',
  agents: (count) => `${count} agents`,
  activeAgents: (count) => `${count} active agents`,
  teams: (count) => `${count} teams`,
  orgsAndTeams: (orgCount, teamCount) => `${orgCount} orgs - ${teamCount} teams`,
  teamRole: (memberCount, activeCount) => `${memberCount} agents - ${activeCount} active`,
  groupSummary: (teamCount, activeTeamCount, taskCount) =>
    `${teamCount} teams · ${activeTeamCount} active · ${taskCount} tasks`,
  teamSummary: (status, activeTaskCount, taskCount) =>
    `${status} · ${activeTaskCount} active · ${taskCount} tasks`,
  teamReference: 'team reference',
  notFound: 'not found',
  online: 'online',
  offline: 'offline',
  agentStatus: (status) => status,
};

function isSystemUnassignedNode(node: OrganizationNodeDto): boolean {
  return node.tags?.includes('unassigned') ?? false;
}

function getOrganizationContainerLabel(
  node: OrganizationNodeDto,
  text: OrganizationGraphText
): string {
  if (node.id === ALL_ORGANIZATIONS_ROOT_NODE_ID) {
    return text.allOrganizations;
  }
  if (isSystemUnassignedNode(node)) {
    return text.unassignedTeams;
  }
  return node.label;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function getTimestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTeamState(node: OrganizationNodeDto): GraphNodeState {
  const team = node.team;
  if (!team) return 'idle';
  if (team.taskCounts.inProgress > 0) return 'active';
  return team.isOnline ? 'idle' : 'terminated';
}

function getTeamSummaryLine(
  team: NonNullable<OrganizationNodeDto['team']>,
  text: OrganizationGraphText
): string {
  const activeTask = team.agents
    .flatMap((agent) =>
      agent.currentTasks.map((task) => ({
        agentName: agent.name,
        subject: task.subject,
      }))
    )
    .at(0);
  if (activeTask) {
    return `${activeTask.agentName}: ${activeTask.subject}`;
  }
  return text.agents(team.memberCount);
}

function buildRootLayoutAnchor(
  viewModel: OrganizationMapViewModel,
  text: OrganizationGraphText
): GraphNode | null {
  const root = viewModel.rootNode;
  if (!root) return null;

  return {
    id: root.id,
    kind: 'lead',
    visualVariant: 'organization',
    layoutOnly: true,
    label: getOrganizationContainerLabel(root, text),
    state: viewModel.stats.activeAgentCount > 0 ? 'active' : 'idle',
    color: root.color ?? '#4f8cff',
    domainRef: {
      kind: 'lead',
      teamName: viewModel.payload.activeOrganizationId,
      memberName: root.id,
    },
  };
}

function buildTeamNode(node: OrganizationNodeDto, text: OrganizationGraphText): GraphNode | null {
  const team = node.team;
  if (!team) {
    return {
      id: node.id,
      kind: 'member',
      visualVariant: 'team',
      label: node.label,
      state: 'terminated',
      color: node.color ?? '#64748b',
      role: node.title ?? text.teamReference,
      runtimeLabel: text.notFound,
      semanticSummary: text.teamSummary(text.notFound, 0, 0),
      currentTaskSubject: node.description,
      domainRef: {
        kind: 'member',
        teamName: node.id,
        memberName: node.id,
      },
    };
  }

  return {
    id: node.id,
    kind: 'member',
    visualVariant: 'team',
    label: team.displayName,
    state: toTeamState(node),
    color: team.color ?? node.color ?? '#8bd3ff',
    role: text.teamRole(team.memberCount, team.taskCounts.inProgress),
    runtimeLabel: team.isOnline ? text.online : text.offline,
    semanticSummary: text.teamSummary(
      team.isOnline ? text.online : text.offline,
      team.taskCounts.inProgress,
      team.taskCounts.pending + team.taskCounts.inProgress + team.taskCounts.completed
    ),
    currentTaskSubject: getTeamSummaryLine(team, text),
    domainRef: {
      kind: 'member',
      teamName: team.teamName,
      memberName: node.id,
    },
  };
}

function collectDescendantTeamStats(
  viewModel: OrganizationMapViewModel,
  nodeId: string,
  seen = new Set<string>()
): {
  teamCount: number;
  activeTeamCount: number;
  activeAgentCount: number;
  activeTaskCount: number;
  taskCount: number;
} {
  if (seen.has(nodeId)) {
    return {
      teamCount: 0,
      activeTeamCount: 0,
      activeAgentCount: 0,
      activeTaskCount: 0,
      taskCount: 0,
    };
  }
  seen.add(nodeId);

  const node = viewModel.nodeById.get(nodeId);
  if (node?.kind === 'team') {
    return {
      teamCount: 1,
      activeTeamCount: (node.team?.taskCounts.inProgress ?? 0) > 0 ? 1 : 0,
      activeAgentCount: node.team?.agents.filter((agent) => agent.status === 'active').length ?? 0,
      activeTaskCount: node.team?.taskCounts.inProgress ?? 0,
      taskCount: node.team
        ? node.team.taskCounts.pending +
          node.team.taskCounts.inProgress +
          node.team.taskCounts.completed
        : 0,
    };
  }

  return (viewModel.childNodeIdsByParentId.get(nodeId) ?? []).reduce(
    (total, childNodeId) => {
      const childStats = collectDescendantTeamStats(viewModel, childNodeId, seen);
      return {
        teamCount: total.teamCount + childStats.teamCount,
        activeTeamCount: total.activeTeamCount + childStats.activeTeamCount,
        activeAgentCount: total.activeAgentCount + childStats.activeAgentCount,
        activeTaskCount: total.activeTaskCount + childStats.activeTaskCount,
        taskCount: total.taskCount + childStats.taskCount,
      };
    },
    { teamCount: 0, activeTeamCount: 0, activeAgentCount: 0, activeTaskCount: 0, taskCount: 0 }
  );
}

function buildCollapsedContainerNode(
  node: OrganizationNodeDto,
  viewModel: OrganizationMapViewModel,
  text: OrganizationGraphText
): GraphNode {
  const stats = collectDescendantTeamStats(viewModel, node.id);
  return {
    id: node.id,
    kind: 'member',
    visualVariant: node.kind === 'organization' ? 'organization' : 'container',
    label: getOrganizationContainerLabel(node, text),
    state: stats.activeAgentCount > 0 ? 'active' : 'idle',
    color: node.color ?? (node.kind === 'organization' ? '#4f8cff' : '#8bd3ff'),
    role: text.teams(stats.teamCount),
    runtimeLabel:
      stats.activeAgentCount > 0 ? text.activeAgents(stats.activeAgentCount) : undefined,
    semanticSummary: text.groupSummary(stats.teamCount, stats.activeTeamCount, stats.taskCount),
    domainRef: {
      kind: 'member',
      teamName: node.id,
      memberName: node.id,
    },
  };
}

function buildOrgGraphNode(
  node: OrganizationNodeDto,
  viewModel: OrganizationMapViewModel,
  collapsedVisibleContainerNodeIds: ReadonlySet<string>,
  text: OrganizationGraphText
): GraphNode | null {
  if (node.id === viewModel.rootNode?.id) {
    return buildRootLayoutAnchor(viewModel, text);
  }
  if (node.kind === 'team') {
    return buildTeamNode(node, text);
  }
  const childCount = viewModel.childNodeIdsByParentId.get(node.id)?.length ?? 0;
  if (collapsedVisibleContainerNodeIds.has(node.id) || childCount === 0) {
    return buildCollapsedContainerNode(node, viewModel, text);
  }
  return null;
}

interface RenderableAgentTask {
  agent: OrganizationAgentDto;
  task: OrganizationAgentDto['currentTasks'][number];
  index: number;
}

function getRenderableAgentTasks(node: OrganizationNodeDto): RenderableAgentTask[] {
  return (node.team?.agents ?? [])
    .map((agent, index) => {
      const task = agent.currentTasks
        .filter((candidate) => candidate.status === 'in_progress')
        .sort((left, right) => getTimestampMs(right.updatedAt) - getTimestampMs(left.updatedAt))
        .at(0);
      return task ? { agent, task, index } : null;
    })
    .filter((item): item is RenderableAgentTask => item !== null)
    .sort((left, right) => {
      const timestampDelta =
        getTimestampMs(right.task.updatedAt) - getTimestampMs(left.task.updatedAt);
      return timestampDelta !== 0 ? timestampDelta : right.index - left.index;
    })
    .slice(0, MAX_ACTIVE_AGENT_TASKS_PER_TEAM);
}

function buildAgentTaskNodes(
  node: OrganizationNodeDto,
  text: OrganizationGraphText,
  options: { taskZoomVisibility?: GraphNode['taskZoomVisibility'] } = {}
): GraphNode[] {
  const team = node.team;
  if (!team) return [];

  return getRenderableAgentTasks(node).map(({ agent, task }) => {
    return {
      id: agent.id,
      kind: 'task',
      label: agent.name,
      state: 'active',
      color: agent.color,
      ownerId: node.id,
      displayId: `${agent.name} - ${text.agentStatus(agent.status)}`,
      sublabel: task.subject,
      taskStatus: 'in_progress',
      reviewState: 'none',
      taskZoomVisibility: options.taskZoomVisibility,
      domainRef: {
        kind: 'task',
        teamName: team.teamName,
        taskId: task.id,
      },
    };
  });
}

function buildContainmentEdges(viewModel: OrganizationMapViewModel): GraphEdge[] {
  return viewModel.containsRelations.map((relation) => ({
    id: relation.id,
    source: relation.sourceNodeId,
    target: relation.targetNodeId,
    type: 'parent-child',
    color: '#334155',
  }));
}

function buildAgentOwnershipEdges(teamNodes: readonly OrganizationNodeDto[]): GraphEdge[] {
  return teamNodes.flatMap((node) =>
    getRenderableAgentTasks(node).map(({ agent }) => ({
      id: `org-agent:${node.id}:${agent.id}`,
      source: node.id,
      target: agent.id,
      type: 'ownership' as const,
      color: '#34d399',
    }))
  );
}

function getManualRelationEdgeId(relation: OrganizationRelationDto): string {
  return `org-manual:${relation.kind}:${relation.id}:${relation.sourceNodeId}->${relation.targetNodeId}`;
}

function getCommunicationRelationEdgeId(relation: OrganizationRelationDto): string {
  return `org-message:${relation.id}:${relation.sourceNodeId}->${relation.targetNodeId}`;
}

function buildCommunicationEdges(relations: readonly OrganizationRelationDto[]): GraphEdge[] {
  return relations.map((relation) => ({
    id: getCommunicationRelationEdgeId(relation),
    source: relation.sourceNodeId,
    target: relation.targetNodeId,
    type: 'message',
    label: relation.latestMessagePreview,
    color: '#8b9cff',
    aggregateCount: relation.messageCount ?? relation.weight,
  }));
}

function getManualRelationColor(kind: string): string {
  if (kind === 'depends_on') return '#f59e0b';
  if (kind === 'delegates') return '#22c55e';
  if (kind === 'observes') return '#38bdf8';
  if (kind === 'handoff') return '#a78bfa';
  if (kind === 'review') return '#2dd4bf';
  return '#94a3b8';
}

function formatManualRelationLabel(relation: OrganizationRelationDto): string {
  const kindLabel = relation.kind.replaceAll('_', ' ');
  const label = relation.label?.trim();
  if (!label || label === relation.kind || label === kindLabel) {
    return kindLabel;
  }
  return `${kindLabel}: ${label}`;
}

function buildManualRelationEdges(relations: readonly OrganizationRelationDto[]): GraphEdge[] {
  return relations.map((relation) => ({
    id: getManualRelationEdgeId(relation),
    source: relation.sourceNodeId,
    target: relation.targetNodeId,
    type: relation.kind === 'depends_on' ? ('blocking' as const) : ('related' as const),
    label: formatManualRelationLabel(relation),
    color: getManualRelationColor(relation.kind),
    aggregateCount: relation.weight,
  }));
}

function buildCommunicationParticles(
  relations: readonly OrganizationRelationDto[],
  maxParticleCount: number
): GraphParticle[] {
  const particles: GraphParticle[] = [];

  for (const relation of relations) {
    if (particles.length >= maxParticleCount) {
      break;
    }
    const edgeId = getCommunicationRelationEdgeId(relation);
    const remaining = maxParticleCount - particles.length;
    const count = Math.max(
      1,
      Math.min(MAX_PARTICLES_PER_RELATION, relation.messageCount ?? 1, remaining)
    );
    particles.push(
      ...Array.from({ length: count }, (_, index) => {
        const seed = hashString(`${relation.id}:${relation.lastActivityAt ?? ''}:${index}`);
        return {
          id: `org-msg:${edgeId}:${relation.lastActivityAt ?? 'unknown'}:${index}`,
          edgeId,
          progress: (seed % 70) / 100,
          kind: 'inbox_message' as const,
          color: index === 0 ? '#8fd3ff' : '#a78bfa',
          size: index === 0 ? 1.1 : 0.85,
          label:
            index === 0 && (relation.messageCount ?? 0) > 1
              ? String(relation.messageCount)
              : undefined,
          preview: relation.latestMessagePreview,
        };
      })
    );
  }

  return particles;
}

function getSelectedVisibleTeamNodeId(
  viewModel: OrganizationMapViewModel,
  visibleOrganizationNodeIds: ReadonlySet<string>,
  selectedNodeId: string | null | undefined
): string | null {
  if (!selectedNodeId || !visibleOrganizationNodeIds.has(selectedNodeId)) {
    return null;
  }
  const selectedNode = viewModel.nodeById.get(selectedNodeId);
  return selectedNode?.kind === 'team' ? selectedNode.id : null;
}

function shouldUseSelectiveAgentDetails(
  viewModel: OrganizationMapViewModel,
  visibleTeamCount: number
): boolean {
  return (
    visibleTeamCount > SELECTIVE_AGENT_DETAILS_TEAM_THRESHOLD ||
    viewModel.stats.agentCount > SELECTIVE_AGENT_DETAILS_AGENT_THRESHOLD ||
    viewModel.communicationRelations.length > SELECTIVE_AGENT_DETAILS_MESSAGE_THRESHOLD
  );
}

function getLayoutMode(_ownerCount: number): GraphLayoutMode {
  return 'grid-under-lead';
}

function getOrganizationGridColumnCount(ownerCount: number): number {
  if (ownerCount <= COMPACT_LAYOUT_MAX_OWNER_COUNT) {
    return Math.max(1, Math.min(ownerCount, ORGANIZATION_GRID_COMPACT_MAX_COLUMN_COUNT));
  }
  return Math.max(
    3,
    Math.min(ORGANIZATION_GRID_MAX_COLUMN_COUNT, Math.ceil(Math.sqrt(ownerCount * 1.6)))
  );
}

interface OrganizationGridBlock {
  width: number;
  height: number;
  packable?: boolean;
  assignments: Array<{
    nodeId: string;
    rowIndex: number;
    columnIndex: number;
  }>;
}

function buildTeamGridBlock(teamNodeIds: readonly string[]): OrganizationGridBlock | null {
  if (teamNodeIds.length === 0) {
    return null;
  }

  const columnCount = getOrganizationGridColumnCount(teamNodeIds.length);
  return {
    width: columnCount,
    height: Math.ceil(teamNodeIds.length / columnCount),
    assignments: teamNodeIds.map((nodeId, index) => ({
      nodeId,
      rowIndex: Math.floor(index / columnCount),
      columnIndex: index % columnCount,
    })),
  };
}

function collectDescendantTeamNodeIdsForLayout(
  viewModel: OrganizationMapViewModel,
  nodeId: string,
  seen = new Set<string>()
): string[] {
  if (seen.has(nodeId)) {
    return [];
  }
  seen.add(nodeId);

  const node = viewModel.nodeById.get(nodeId);
  if (node?.kind === 'team') {
    return [node.id];
  }

  return (viewModel.childNodeIdsByParentId.get(nodeId) ?? []).flatMap((childNodeId) =>
    collectDescendantTeamNodeIdsForLayout(viewModel, childNodeId, seen)
  );
}

function buildCollapsedContainerGridBlock(
  viewModel: OrganizationMapViewModel,
  nodeId: string
): OrganizationGridBlock {
  const expandedOwnerOrder = collectDescendantTeamNodeIdsForLayout(viewModel, nodeId);
  const expandedBlock =
    expandedOwnerOrder.length > 0
      ? buildNestedOrganizationGridBlock(
          viewModel,
          nodeId,
          new Set(expandedOwnerOrder),
          new Set<string>()
        )
      : null;
  const width = Math.max(1, expandedBlock?.width ?? 1);
  const height = Math.max(1, expandedBlock?.height ?? 1);

  return {
    width,
    height,
    assignments: [
      {
        nodeId,
        rowIndex: Math.floor((height - 1) / 2),
        columnIndex: Math.floor((width - 1) / 2),
      },
    ],
  };
}

interface OrganizationGridPackingOptions {
  maxBlockWidth?: number;
  maxBlockHeight?: number;
  maxBlocksPerRow?: number;
  maxRowWidth?: number;
  rowGap?: number;
  columnGap?: number;
}

function canPackOrganizationGridBlockSideBySide(
  block: OrganizationGridBlock,
  options: OrganizationGridPackingOptions = {}
): boolean {
  const maxBlockWidth = options.maxBlockWidth ?? ORGANIZATION_GRID_SIDE_BY_SIDE_MAX_BLOCK_WIDTH;
  const maxBlockHeight = options.maxBlockHeight ?? ORGANIZATION_GRID_SIDE_BY_SIDE_MAX_BLOCK_HEIGHT;
  return block.packable === true && block.width <= maxBlockWidth && block.height <= maxBlockHeight;
}

function getPackedOrganizationGridRowWidth(
  blocks: readonly OrganizationGridBlock[],
  columnGap = ORGANIZATION_GRID_BLOCK_COLUMN_GAP
): number {
  return (
    blocks.reduce((sum, block) => sum + block.width, 0) + Math.max(0, blocks.length - 1) * columnGap
  );
}

function packOrganizationGridRows(
  blocks: readonly OrganizationGridBlock[],
  options: OrganizationGridPackingOptions = {}
): OrganizationGridBlock[][] {
  const rows: OrganizationGridBlock[][] = [];
  let cursor = 0;

  while (cursor < blocks.length) {
    const block = blocks[cursor];
    if (!block) {
      cursor += 1;
      continue;
    }
    const maxRowWidth = options.maxRowWidth ?? ORGANIZATION_GRID_SIDE_BY_SIDE_MAX_ROW_WIDTH;
    const columnGap = options.columnGap ?? ORGANIZATION_GRID_BLOCK_COLUMN_GAP;

    if (options.maxBlocksPerRow && canPackOrganizationGridBlockSideBySide(block, options)) {
      const row = [block];
      let rowWidth = block.width;
      cursor += 1;

      while (row.length < options.maxBlocksPerRow) {
        const nextBlock = blocks[cursor];
        if (!nextBlock || !canPackOrganizationGridBlockSideBySide(nextBlock, options)) {
          break;
        }
        const nextRowWidth = rowWidth + columnGap + nextBlock.width;
        if (nextRowWidth > maxRowWidth) {
          break;
        }
        row.push(nextBlock);
        rowWidth = nextRowWidth;
        cursor += 1;
      }

      rows.push(row);
      continue;
    }

    const nextBlock = blocks[cursor + 1];
    if (
      canPackOrganizationGridBlockSideBySide(block, options) &&
      nextBlock &&
      canPackOrganizationGridBlockSideBySide(nextBlock, options) &&
      getPackedOrganizationGridRowWidth([block, nextBlock], columnGap) <= maxRowWidth
    ) {
      rows.push([block, nextBlock]);
      cursor += 2;
      continue;
    }

    rows.push([block]);
    cursor += 1;
  }

  return rows;
}

function stackOrganizationGridBlocks(
  blocks: readonly OrganizationGridBlock[],
  options: { packSiblings?: boolean } & OrganizationGridPackingOptions = {}
): OrganizationGridBlock | null {
  const visibleBlocks = blocks.filter((block) => block.assignments.length > 0);
  if (visibleBlocks.length === 0) {
    return null;
  }

  const rows = options.packSiblings
    ? packOrganizationGridRows(visibleBlocks, options)
    : visibleBlocks.map((block) => [block]);
  const columnGap = options.columnGap ?? ORGANIZATION_GRID_BLOCK_COLUMN_GAP;
  const rowGap = options.rowGap ?? ORGANIZATION_GRID_BLOCK_ROW_GAP;
  const width = Math.max(...rows.map((row) => getPackedOrganizationGridRowWidth(row, columnGap)));
  let rowOffset = 0;
  const assignments: OrganizationGridBlock['assignments'] = [];

  rows.forEach((rowBlocks, rowIndex) => {
    const rowWidth = getPackedOrganizationGridRowWidth(rowBlocks, columnGap);
    const rowHeight = Math.max(...rowBlocks.map((block) => block.height));
    let columnOffset = Math.floor((width - rowWidth) / 2);

    for (const block of rowBlocks) {
      assignments.push(
        ...block.assignments.map((assignment) => ({
          nodeId: assignment.nodeId,
          rowIndex: rowOffset + assignment.rowIndex,
          columnIndex: columnOffset + assignment.columnIndex,
        }))
      );
      columnOffset += block.width + columnGap;
    }

    rowOffset += rowHeight + (rowIndex === rows.length - 1 ? 0 : rowGap);
  });

  return {
    width,
    height: rowOffset,
    assignments,
  };
}

function buildNestedOrganizationGridBlock(
  viewModel: OrganizationMapViewModel,
  parentNodeId: string,
  ownerOrderSet: ReadonlySet<string>,
  seen: Set<string>
): OrganizationGridBlock | null {
  const blocks: OrganizationGridBlock[] = [];
  const directTeamNodeIds: string[] = [];

  const flushDirectTeams = (): void => {
    const directTeamBlock = buildTeamGridBlock(directTeamNodeIds);
    if (directTeamBlock) {
      blocks.push(directTeamBlock);
    }
    directTeamNodeIds.length = 0;
  };

  for (const childNodeId of viewModel.childNodeIdsByParentId.get(parentNodeId) ?? []) {
    const childNode = viewModel.nodeById.get(childNodeId);
    if (!childNode) {
      continue;
    }

    if (ownerOrderSet.has(childNode.id)) {
      if (!seen.has(childNode.id)) {
        seen.add(childNode.id);
        if (childNode.kind === 'team') {
          directTeamNodeIds.push(childNode.id);
        } else {
          flushDirectTeams();
          blocks.push({
            ...buildCollapsedContainerGridBlock(viewModel, childNode.id),
            packable: true,
          });
        }
      }
      continue;
    }

    flushDirectTeams();
    const childBlock = buildNestedOrganizationGridBlock(
      viewModel,
      childNode.id,
      ownerOrderSet,
      seen
    );
    if (childBlock) {
      blocks.push({ ...childBlock, packable: true });
    }
  }

  flushDirectTeams();
  const packsTopLevelOrganizations = parentNodeId === ALL_ORGANIZATIONS_ROOT_NODE_ID;
  const parentNode = viewModel.nodeById.get(parentNodeId);
  const packsAllScopeOrganizationSections =
    viewModel.payload.scope === 'all' &&
    parentNode?.kind === 'organization' &&
    !packsTopLevelOrganizations;
  const stackBlocks = packsTopLevelOrganizations
    ? blocks.slice().sort((left, right) => right.height - left.height || right.width - left.width)
    : blocks;
  return stackOrganizationGridBlocks(stackBlocks, {
    packSiblings: true,
    maxBlockWidth:
      packsTopLevelOrganizations || packsAllScopeOrganizationSections
        ? Number.POSITIVE_INFINITY
        : undefined,
    maxBlockHeight:
      packsTopLevelOrganizations || packsAllScopeOrganizationSections
        ? Number.POSITIVE_INFINITY
        : undefined,
    maxBlocksPerRow: packsTopLevelOrganizations
      ? 2
      : packsAllScopeOrganizationSections
        ? ORGANIZATION_GRID_ALL_SCOPE_ORG_SECTION_MAX_BLOCKS_PER_ROW
        : undefined,
    maxRowWidth: packsTopLevelOrganizations
      ? ORGANIZATION_GRID_TOP_LEVEL_ORG_MAX_ROW_WIDTH
      : packsAllScopeOrganizationSections
        ? ORGANIZATION_GRID_ALL_SCOPE_ORG_SECTION_MAX_ROW_WIDTH
        : undefined,
    rowGap: packsTopLevelOrganizations ? ORGANIZATION_GRID_TOP_LEVEL_ORG_ROW_GAP : undefined,
    columnGap: packsTopLevelOrganizations ? ORGANIZATION_GRID_TOP_LEVEL_ORG_COLUMN_GAP : undefined,
  });
}

function buildGridSlotAssignments(
  viewModel: OrganizationMapViewModel,
  ownerOrder: readonly string[]
): Record<string, GraphOwnerSlotAssignment> {
  const ownerOrderSet = new Set(ownerOrder);
  const seen = new Set<string>();
  const rootBlock = viewModel.rootNode
    ? buildNestedOrganizationGridBlock(viewModel, viewModel.rootNode.id, ownerOrderSet, seen)
    : null;
  const missingOwnerBlock = buildTeamGridBlock(ownerOrder.filter((nodeId) => !seen.has(nodeId)));
  const combinedBlock = stackOrganizationGridBlocks(
    [rootBlock, missingOwnerBlock].filter((block): block is OrganizationGridBlock => block !== null)
  );
  const assignments: Record<string, GraphOwnerSlotAssignment> = {};

  for (const assignment of combinedBlock?.assignments ?? []) {
    assignments[assignment.nodeId] = {
      ringIndex: assignment.rowIndex + ORGANIZATION_GRID_TOP_ROW_OFFSET,
      sectorIndex: assignment.columnIndex,
    };
  }

  return assignments;
}

function buildLayoutSlotAssignments(
  viewModel: OrganizationMapViewModel,
  ownerOrder: readonly string[],
  layoutMode: GraphLayoutMode
): Record<string, GraphOwnerSlotAssignment> {
  if (layoutMode === 'grid-under-lead') {
    return buildGridSlotAssignments(viewModel, ownerOrder);
  }
  return buildSlotAssignments(viewModel, ownerOrder);
}

function collectVisibleOwnerSubtreeNodeIds(
  viewModel: OrganizationMapViewModel,
  nodeId: string,
  visibleNodeIds: ReadonlySet<string>,
  ownerNodeIds: ReadonlySet<string>,
  rootNodeId: string | undefined,
  seen: Set<string>
): string[] {
  if (seen.has(nodeId) || nodeId === rootNodeId || !visibleNodeIds.has(nodeId)) {
    return [];
  }
  seen.add(nodeId);

  if (ownerNodeIds.has(nodeId)) {
    return [nodeId];
  }

  const childOwnerNodeIds = (viewModel.childNodeIdsByParentId.get(nodeId) ?? []).flatMap(
    (childId) =>
      collectVisibleOwnerSubtreeNodeIds(
        viewModel,
        childId,
        visibleNodeIds,
        ownerNodeIds,
        rootNodeId,
        seen
      )
  );
  return childOwnerNodeIds;
}

function buildGroupedOwnerOrder(
  viewModel: OrganizationMapViewModel,
  visibleNodeIds: ReadonlySet<string>,
  fallbackOwnerOrder: readonly string[]
): string[] {
  const rootNodeId = viewModel.rootNode?.id;
  const ownerNodeIds = new Set(fallbackOwnerOrder);
  const topLevelNodeIds = rootNodeId
    ? (viewModel.childNodeIdsByParentId.get(rootNodeId) ?? []).filter((nodeId) =>
        visibleNodeIds.has(nodeId)
      )
    : [];

  if (topLevelNodeIds.length === 0) {
    return [...fallbackOwnerOrder];
  }

  const seen = new Set<string>();
  const topLevelGroups = topLevelNodeIds
    .map((nodeId) =>
      collectVisibleOwnerSubtreeNodeIds(
        viewModel,
        nodeId,
        visibleNodeIds,
        ownerNodeIds,
        rootNodeId,
        seen
      )
    )
    .filter((group) => group.length > 0);
  if (topLevelGroups.length === 0) {
    return [...fallbackOwnerOrder];
  }

  const columnCount = Math.min(2, topLevelGroups.length);
  const columns = Array.from({ length: columnCount }, () => [] as string[]);
  topLevelGroups.forEach((group, index) => {
    columns[index % columnCount]?.push(...group);
  });

  const maxColumnLength = Math.max(...columns.map((column) => column.length));
  const orderedNodeIds: string[] = [];
  for (let rowIndex = 0; rowIndex < maxColumnLength; rowIndex += 1) {
    for (const column of columns) {
      const nodeId = column[rowIndex];
      if (nodeId) {
        orderedNodeIds.push(nodeId);
      }
    }
  }

  for (const nodeId of fallbackOwnerOrder) {
    if (!seen.has(nodeId)) {
      orderedNodeIds.push(nodeId);
    }
  }
  return orderedNodeIds;
}

function buildOrganizationGraphContext(
  viewModel: OrganizationMapViewModel,
  options: BuildOrganizationGraphDataOptions
): OrganizationGraphBuildContext {
  const visibleOrganizationNodeIds = getVisibleOrganizationNodeIds(
    viewModel,
    options.collapsedNodeIds ?? new Set()
  );
  const collapsedVisibleContainerNodeIds = getCollapsedVisibleContainerNodeIds(
    viewModel,
    visibleOrganizationNodeIds,
    options.collapsedNodeIds ?? new Set()
  );
  const visibleTeamNodes = viewModel.teamNodes.filter((node) =>
    visibleOrganizationNodeIds.has(node.id)
  );
  const rootNodeId = viewModel.rootNode?.id;
  const fallbackOwnerOrder = viewModel.nodeDisplayOrder.filter(
    (nodeId) =>
      nodeId !== rootNodeId &&
      visibleOrganizationNodeIds.has(nodeId) &&
      (viewModel.nodeById.get(nodeId)?.kind === 'team' ||
        collapsedVisibleContainerNodeIds.has(nodeId))
  );
  const ownerOrder = buildGroupedOwnerOrder(
    viewModel,
    visibleOrganizationNodeIds,
    fallbackOwnerOrder
  );
  const selectedTeamNodeId = getSelectedVisibleTeamNodeId(
    viewModel,
    visibleOrganizationNodeIds,
    options.selectedNodeId
  );
  const showActiveTeamTasks = options.showSelectedTeamDetails ?? true;
  const useSelectiveAgentDetails = shouldUseSelectiveAgentDetails(
    viewModel,
    visibleTeamNodes.length
  );
  const renderedAgentTeamIds = new Set(
    showActiveTeamTasks ? visibleTeamNodes.map((node) => node.id) : []
  );
  const renderedAgentCount = visibleTeamNodes.reduce(
    (count, node) =>
      renderedAgentTeamIds.has(node.id) ? count + getRenderableAgentTasks(node).length : count,
    0
  );
  const detailMode: OrganizationGraphDetailMode = showActiveTeamTasks
    ? 'active-agent-tasks'
    : 'hidden-agent-tasks';

  return {
    detailMode,
    layoutMode: options.layoutMode ?? getLayoutMode(ownerOrder.length),
    selectedTeamNodeId,
    visibleTeamCount: visibleTeamNodes.length,
    visibleOrganizationNodeCount: visibleOrganizationNodeIds.size,
    renderedAgentCount,
    hiddenAgentCount: Math.max(0, viewModel.stats.agentCount - renderedAgentCount),
    maxParticleCount: useSelectiveAgentDetails
      ? MAX_PARTICLES_COMPACT_MAP
      : MAX_PARTICLES_DETAILED_MAP,
    visibleOrganizationNodeIds,
    collapsedVisibleContainerNodeIds,
    visibleTeamNodes,
    renderedAgentTeamIds,
    ownerOrder,
  };
}

export function getOrganizationGraphRenderProfile(
  viewModel: OrganizationMapViewModel,
  options: BuildOrganizationGraphDataOptions = {}
): OrganizationGraphRenderProfile {
  const {
    detailMode,
    layoutMode,
    selectedTeamNodeId,
    visibleTeamCount,
    visibleOrganizationNodeCount,
    renderedAgentCount,
    hiddenAgentCount,
    maxParticleCount,
  } = buildOrganizationGraphContext(viewModel, options);

  return {
    detailMode,
    layoutMode,
    selectedTeamNodeId,
    visibleTeamCount,
    visibleOrganizationNodeCount,
    renderedAgentCount,
    hiddenAgentCount,
    maxParticleCount,
  };
}

function buildDepthByNodeId(viewModel: OrganizationMapViewModel): Map<string, number> {
  const depthByNodeId = new Map<string, number>();
  const rootNodeId = viewModel.rootNode?.id;
  const visit = (nodeId: string, depth: number): void => {
    if (depthByNodeId.has(nodeId)) return;
    depthByNodeId.set(nodeId, depth);
    for (const childId of viewModel.childNodeIdsByParentId.get(nodeId) ?? []) {
      visit(childId, depth + 1);
    }
  };

  if (rootNodeId) {
    visit(rootNodeId, 0);
  }
  for (const node of viewModel.organizationNodes) {
    if (!depthByNodeId.has(node.id)) {
      visit(node.id, 1);
    }
  }
  return depthByNodeId;
}

function getVisibleOrganizationNodeIds(
  viewModel: OrganizationMapViewModel,
  collapsedNodeIds: ReadonlySet<string>
): Set<string> {
  const visible = new Set<string>();
  const rootNodeId = viewModel.rootNode?.id;

  const visit = (nodeId: string, hiddenByAncestor: boolean): void => {
    if (hiddenByAncestor) return;
    visible.add(nodeId);
    const collapseChildren = collapsedNodeIds.has(nodeId);
    for (const childId of viewModel.childNodeIdsByParentId.get(nodeId) ?? []) {
      visit(childId, collapseChildren);
    }
  };

  if (rootNodeId) {
    visit(rootNodeId, false);
  }
  for (const node of viewModel.organizationNodes) {
    if (!visible.has(node.id) && !viewModel.parentNodeIdByChildId.has(node.id)) {
      visit(node.id, false);
    }
  }
  return visible;
}

function getCollapsedVisibleContainerNodeIds(
  viewModel: OrganizationMapViewModel,
  visibleNodeIds: ReadonlySet<string>,
  collapsedNodeIds: ReadonlySet<string>
): Set<string> {
  const rootNodeId = viewModel.rootNode?.id;
  return new Set(
    [...collapsedNodeIds].filter((nodeId) => {
      if (nodeId === rootNodeId || !visibleNodeIds.has(nodeId)) {
        return false;
      }
      const node = viewModel.nodeById.get(nodeId);
      return (
        node !== undefined &&
        node.kind !== 'team' &&
        (viewModel.childNodeIdsByParentId.get(nodeId)?.length ?? 0) > 0
      );
    })
  );
}

function resolveVisibleEndpoint(
  nodeId: string,
  visibleNodeIds: ReadonlySet<string>,
  parentNodeIdByChildId: ReadonlyMap<string, string>
): string | null {
  let current: string | undefined = nodeId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (visibleNodeIds.has(current)) {
      return current;
    }
    seen.add(current);
    current = parentNodeIdByChildId.get(current);
  }
  return null;
}

function buildVisibleManualRelations(
  viewModel: OrganizationMapViewModel,
  visibleNodeIds: ReadonlySet<string>
): OrganizationRelationDto[] {
  const relationsByKey = new Map<string, OrganizationRelationDto>();
  for (const relation of viewModel.manualRelations) {
    const sourceNodeId = resolveVisibleEndpoint(
      relation.sourceNodeId,
      visibleNodeIds,
      viewModel.parentNodeIdByChildId
    );
    const targetNodeId = resolveVisibleEndpoint(
      relation.targetNodeId,
      visibleNodeIds,
      viewModel.parentNodeIdByChildId
    );
    if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
      continue;
    }
    const key = `${relation.kind}:${sourceNodeId}->${targetNodeId}`;
    const previous = relationsByKey.get(key);
    if (previous) {
      previous.weight += relation.weight;
      previous.label = previous.label ?? relation.label;
      continue;
    }
    relationsByKey.set(key, {
      ...relation,
      id:
        sourceNodeId === relation.sourceNodeId && targetNodeId === relation.targetNodeId
          ? relation.id
          : `rel:${relation.kind}:${sourceNodeId}->${targetNodeId}`,
      sourceNodeId,
      targetNodeId,
    });
  }
  return [...relationsByKey.values()];
}

function buildVisibleCommunicationRelations(
  viewModel: OrganizationMapViewModel,
  visibleNodeIds: ReadonlySet<string>
): OrganizationRelationDto[] {
  const relationsByPair = new Map<string, OrganizationRelationDto>();
  for (const relation of viewModel.communicationRelations) {
    const sourceNodeId = resolveVisibleEndpoint(
      relation.sourceNodeId,
      visibleNodeIds,
      viewModel.parentNodeIdByChildId
    );
    const targetNodeId = resolveVisibleEndpoint(
      relation.targetNodeId,
      visibleNodeIds,
      viewModel.parentNodeIdByChildId
    );
    if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
      continue;
    }

    const key = `${sourceNodeId}->${targetNodeId}`;
    const previous = relationsByPair.get(key);
    if (!previous) {
      relationsByPair.set(key, {
        ...relation,
        id:
          sourceNodeId === relation.sourceNodeId && targetNodeId === relation.targetNodeId
            ? relation.id
            : `rel:communicates:${sourceNodeId}->${targetNodeId}`,
        sourceNodeId,
        targetNodeId,
      });
      continue;
    }

    const previousCount = previous.messageCount ?? previous.weight;
    const relationCount = relation.messageCount ?? relation.weight;
    previous.weight += relation.weight;
    previous.messageCount = previousCount + relationCount;
    if (getTimestampMs(relation.lastActivityAt) >= getTimestampMs(previous.lastActivityAt)) {
      previous.lastActivityAt = relation.lastActivityAt;
      previous.latestMessagePreview =
        relation.latestMessagePreview ?? previous.latestMessagePreview;
    }
  }
  return [...relationsByPair.values()];
}

function buildSlotAssignments(
  viewModel: OrganizationMapViewModel,
  ownerOrder: readonly string[]
): Record<string, { ringIndex: number; sectorIndex: number }> {
  const depthByNodeId = buildDepthByNodeId(viewModel);
  const nextSectorByRing = new Map<number, number>();

  return Object.fromEntries(
    ownerOrder.map((nodeId) => {
      const ringIndex = Math.max(0, (depthByNodeId.get(nodeId) ?? 1) - 1);
      const sectorIndex = nextSectorByRing.get(ringIndex) ?? 0;
      nextSectorByRing.set(ringIndex, sectorIndex + 1);
      return [
        nodeId,
        {
          ringIndex,
          sectorIndex,
        },
      ];
    })
  );
}

function collectVisibleDescendantNodeIds(
  viewModel: OrganizationMapViewModel,
  nodeId: string,
  visibleNodeIds: ReadonlySet<string>,
  seen = new Set<string>()
): string[] {
  if (seen.has(nodeId)) return [];
  seen.add(nodeId);

  const descendantNodeIds: string[] = [];
  for (const childId of viewModel.childNodeIdsByParentId.get(nodeId) ?? []) {
    if (!visibleNodeIds.has(childId)) {
      continue;
    }
    descendantNodeIds.push(childId);
    descendantNodeIds.push(
      ...collectVisibleDescendantNodeIds(viewModel, childId, visibleNodeIds, seen)
    );
  }
  return descendantNodeIds;
}

function getGroupFrameDepth(viewModel: OrganizationMapViewModel, nodeId: string): number {
  let depth = 0;
  let currentNodeId = viewModel.parentNodeIdByChildId.get(nodeId);
  const rootNodeId = viewModel.rootNode?.id;
  const seen = new Set<string>([nodeId]);

  while (currentNodeId && currentNodeId !== rootNodeId && !seen.has(currentNodeId)) {
    seen.add(currentNodeId);
    depth += 1;
    currentNodeId = viewModel.parentNodeIdByChildId.get(currentNodeId);
  }

  return depth;
}

function buildOrganizationGroupFrames(
  viewModel: OrganizationMapViewModel,
  context: OrganizationGraphBuildContext,
  text: OrganizationGraphText
): GraphGroupFrame[] {
  return viewModel.nodeDisplayOrder
    .map((nodeId) => viewModel.nodeById.get(nodeId))
    .filter(
      (node): node is OrganizationNodeDto =>
        node !== undefined &&
        context.visibleOrganizationNodeIds.has(node.id) &&
        (node.kind === 'container' ||
          (node.kind === 'organization' && node.id !== viewModel.rootNode?.id))
    )
    .map((node) => {
      const descendantNodeIds = collectVisibleDescendantNodeIds(
        viewModel,
        node.id,
        context.visibleOrganizationNodeIds
      );
      const depth = getGroupFrameDepth(viewModel, node.id);
      const deepestVisibleFrameDepth = descendantNodeIds.reduce((deepestDepth, descendantId) => {
        const descendantNode = viewModel.nodeById.get(descendantId);
        if (
          !descendantNode ||
          (descendantNode.kind !== 'container' && descendantNode.kind !== 'organization')
        ) {
          return deepestDepth;
        }
        return Math.max(deepestDepth, getGroupFrameDepth(viewModel, descendantId));
      }, depth);
      const labelLane = Math.max(0, deepestVisibleFrameDepth - depth);
      if (context.collapsedVisibleContainerNodeIds.has(node.id) || descendantNodeIds.length === 0) {
        const stats = collectDescendantTeamStats(viewModel, node.id);
        return {
          id: node.id,
          label: getOrganizationContainerLabel(node, text),
          semanticSummary: text.groupSummary(
            stats.teamCount,
            stats.activeTeamCount,
            stats.taskCount
          ),
          nodeIds: [node.id],
          color: node.color ?? (node.kind === 'organization' ? '#4f8cff' : '#8bd3ff'),
          depth,
          ...(labelLane > 0 ? { labelLane } : {}),
          priority: node.kind === 'organization' ? ('primary' as const) : ('normal' as const),
        };
      }
      const renderedAgentNodeIds = descendantNodeIds.flatMap((descendantNodeId) => {
        if (!context.renderedAgentTeamIds.has(descendantNodeId)) {
          return [];
        }
        const descendantNode = viewModel.nodeById.get(descendantNodeId);
        return descendantNode
          ? getRenderableAgentTasks(descendantNode).map(({ agent }) => agent.id)
          : [];
      });
      const stats = collectDescendantTeamStats(viewModel, node.id);
      return {
        id: node.id,
        label: getOrganizationContainerLabel(node, text),
        semanticSummary: text.groupSummary(stats.teamCount, stats.activeTeamCount, stats.taskCount),
        nodeIds: [...descendantNodeIds, ...renderedAgentNodeIds],
        color: node.color ?? (node.kind === 'organization' ? '#4f8cff' : '#8bd3ff'),
        depth,
        ...(labelLane > 0 ? { labelLane } : {}),
        priority: node.kind === 'organization' ? ('primary' as const) : ('normal' as const),
      };
    })
    .filter((frame) => frame.nodeIds.length > 0);
}

function buildHierarchyGraphNode(
  node: OrganizationNodeDto,
  viewModel: OrganizationMapViewModel,
  text: OrganizationGraphText
): GraphNode {
  const hierarchyDepth = getHierarchyNodeDepth(viewModel, node.id);
  if (node.kind === 'team') {
    return { ...buildTeamNode(node, text)!, hierarchyDepth };
  }

  const graphNode = buildCollapsedContainerNode(node, viewModel, text);
  if (node.id !== viewModel.rootNode?.id) {
    return { ...graphNode, hierarchyDepth };
  }

  const role =
    viewModel.payload.scope === 'all'
      ? text.orgsAndTeams(viewModel.payload.organizations.length, viewModel.stats.teamCount)
      : text.teams(viewModel.stats.teamCount);
  return {
    ...graphNode,
    kind: 'lead',
    visualVariant: 'organization',
    hierarchyDepth,
    role,
    runtimeLabel: undefined,
    currentTaskSubject: node.description,
    domainRef: {
      kind: 'lead',
      teamName: viewModel.payload.activeOrganizationId,
      memberName: node.id,
    },
  };
}

function getHierarchyNodeDepth(viewModel: OrganizationMapViewModel, nodeId: string): number {
  let depth = 0;
  let currentNodeId = viewModel.parentNodeIdByChildId.get(nodeId);
  const seen = new Set<string>([nodeId]);
  while (currentNodeId && !seen.has(currentNodeId)) {
    seen.add(currentNodeId);
    depth += 1;
    currentNodeId = viewModel.parentNodeIdByChildId.get(currentNodeId);
  }
  return depth;
}

function buildHierarchyNodePositions(
  viewModel: OrganizationMapViewModel,
  visibleNodeIds: ReadonlySet<string>,
  renderedAgentTeamNodes: readonly OrganizationNodeDto[]
): Record<string, GraphNodePosition> {
  const positions = new Map<string, GraphNodePosition>();
  const visited = new Set<string>();
  let nextLeafIndex = 0;

  const visit = (nodeId: string, depth: number, ancestors: ReadonlySet<string>): number => {
    const existing = positions.get(nodeId);
    if (existing) {
      return existing.x;
    }

    if (ancestors.has(nodeId)) {
      const cycleX = nextLeafIndex * HIERARCHY_HORIZONTAL_GAP;
      nextLeafIndex += 1;
      return cycleX;
    }

    visited.add(nodeId);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeId);
    const childNodeIds = (viewModel.childNodeIdsByParentId.get(nodeId) ?? []).filter(
      (childNodeId) => visibleNodeIds.has(childNodeId) && !nextAncestors.has(childNodeId)
    );
    const childXPositions = childNodeIds.map((childNodeId) =>
      visit(childNodeId, depth + 1, nextAncestors)
    );
    const x =
      childXPositions.length === 0
        ? nextLeafIndex++ * HIERARCHY_HORIZONTAL_GAP
        : (Math.min(...childXPositions) + Math.max(...childXPositions)) / 2;
    positions.set(nodeId, { x, y: depth * HIERARCHY_VERTICAL_GAP });
    return x;
  };

  const rootNodeId = viewModel.rootNode?.id;
  const rootNodeIds =
    rootNodeId && visibleNodeIds.has(rootNodeId)
      ? [rootNodeId]
      : viewModel.nodeDisplayOrder.filter((nodeId) => {
          if (!visibleNodeIds.has(nodeId)) return false;
          const parentNodeId = viewModel.parentNodeIdByChildId.get(nodeId);
          return !parentNodeId || !visibleNodeIds.has(parentNodeId);
        });

  rootNodeIds.forEach((nodeId, index) => {
    if (index > 0) nextLeafIndex += HIERARCHY_ROOT_GAP_IN_LEAVES;
    visit(nodeId, 0, new Set());
  });

  for (const nodeId of viewModel.nodeDisplayOrder) {
    if (!visibleNodeIds.has(nodeId) || visited.has(nodeId)) continue;
    nextLeafIndex += HIERARCHY_ROOT_GAP_IN_LEAVES;
    visit(nodeId, 0, new Set());
  }

  const xPositions = [...positions.values()].map((position) => position.x);
  const centerX =
    xPositions.length > 0 ? (Math.min(...xPositions) + Math.max(...xPositions)) / 2 : 0;
  const centeredPositions = new Map<string, GraphNodePosition>(
    [...positions].map(([nodeId, position]) => [nodeId, { x: position.x - centerX, y: position.y }])
  );

  for (const teamNode of renderedAgentTeamNodes) {
    const teamPosition = centeredPositions.get(teamNode.id);
    if (!teamPosition) continue;
    getRenderableAgentTasks(teamNode).forEach(({ agent }, index) => {
      centeredPositions.set(agent.id, {
        x: teamPosition.x,
        y: teamPosition.y + HIERARCHY_TASK_TOP_OFFSET + index * HIERARCHY_TASK_VERTICAL_GAP,
      });
    });
  }

  return Object.fromEntries(centeredPositions);
}

function buildHierarchicalOrganizationGraphData(
  viewModel: OrganizationMapViewModel,
  context: OrganizationGraphBuildContext,
  text: OrganizationGraphText
): GraphDataPort {
  const hierarchyStructureNodes = viewModel.nodeDisplayOrder
    .map((nodeId) => viewModel.nodeById.get(nodeId))
    .filter(
      (node): node is OrganizationNodeDto =>
        node !== undefined && context.visibleOrganizationNodeIds.has(node.id)
    )
    .map((node) => buildHierarchyGraphNode(node, viewModel, text));
  const renderedAgentTeamNodes = context.visibleTeamNodes.filter((node) =>
    context.renderedAgentTeamIds.has(node.id)
  );
  const hierarchyTaskNodes = renderedAgentTeamNodes.flatMap((node) =>
    buildAgentTaskNodes(node, text, { taskZoomVisibility: 'summary' })
  );
  const hierarchyNodes = [...hierarchyStructureNodes, ...hierarchyTaskNodes];
  const graphNodeIds = new Set(hierarchyNodes.map((node) => node.id));
  const visibleManualRelations = buildVisibleManualRelations(
    viewModel,
    context.visibleOrganizationNodeIds
  ).filter(
    (relation) => graphNodeIds.has(relation.sourceNodeId) && graphNodeIds.has(relation.targetNodeId)
  );
  const visibleCommunicationRelations = buildVisibleCommunicationRelations(
    viewModel,
    context.visibleOrganizationNodeIds
  ).filter(
    (relation) => graphNodeIds.has(relation.sourceNodeId) && graphNodeIds.has(relation.targetNodeId)
  );
  const containmentEdges = buildContainmentEdges(viewModel)
    .filter((edge) => graphNodeIds.has(edge.source) && graphNodeIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      color: '#5d7893',
      alwaysVisible: true,
      routing: 'orthogonal' as const,
    }));

  return {
    teamName: text.organizationMap,
    teamColor: viewModel.rootNode?.color,
    isAlive: viewModel.stats.onlineTeamCount > 0,
    groupFrames: [],
    nodes: hierarchyNodes,
    edges: [
      ...containmentEdges,
      ...buildAgentOwnershipEdges(renderedAgentTeamNodes),
      ...buildManualRelationEdges(visibleManualRelations),
      ...buildCommunicationEdges(visibleCommunicationRelations),
    ],
    particles: buildCommunicationParticles(visibleCommunicationRelations, context.maxParticleCount),
    layout: {
      version: 'stable-slots-v1',
      mode: 'hierarchical',
      showActivity: false,
      showLogs: false,
      showTasks: renderedAgentTeamNodes.length > 0,
      fitTaskRowsToContent: true,
      ownerOrder: renderedAgentTeamNodes.map((node) => node.id),
      slotAssignments: {},
      nodePositions: buildHierarchyNodePositions(
        viewModel,
        context.visibleOrganizationNodeIds,
        renderedAgentTeamNodes
      ),
    },
  };
}

export function buildOrganizationGraphData(
  viewModel: OrganizationMapViewModel,
  options: BuildOrganizationGraphDataOptions = {}
): GraphDataPort {
  const text = options.text ?? DEFAULT_ORGANIZATION_GRAPH_TEXT;
  const context = buildOrganizationGraphContext(viewModel, options);
  if (context.layoutMode === 'hierarchical') {
    return buildHierarchicalOrganizationGraphData(viewModel, context, text);
  }
  const { visibleOrganizationNodeIds, visibleTeamNodes, renderedAgentTeamIds, ownerOrder } =
    context;
  const visibleCommunicationRelations = buildVisibleCommunicationRelations(
    viewModel,
    visibleOrganizationNodeIds
  );
  const visibleManualRelations = buildVisibleManualRelations(viewModel, visibleOrganizationNodeIds);
  const orgNodes = viewModel.nodeDisplayOrder
    .map((nodeId) => viewModel.nodeById.get(nodeId))
    .filter(
      (node): node is OrganizationNodeDto =>
        node !== undefined && visibleOrganizationNodeIds.has(node.id)
    )
    .map((node) =>
      buildOrgGraphNode(node, viewModel, context.collapsedVisibleContainerNodeIds, text)
    )
    .filter((node): node is GraphNode => Boolean(node));
  const renderedAgentTeamNodes = visibleTeamNodes.filter((node) =>
    renderedAgentTeamIds.has(node.id)
  );
  const agentNodes = renderedAgentTeamNodes.flatMap((node) => buildAgentTaskNodes(node, text));
  const nodes = [...orgNodes, ...agentNodes];
  const graphNodeIds = new Set(nodes.map((node) => node.id));
  const renderedManualRelations = visibleManualRelations.filter(
    (relation) => graphNodeIds.has(relation.sourceNodeId) && graphNodeIds.has(relation.targetNodeId)
  );
  const renderedCommunicationRelations = visibleCommunicationRelations.filter(
    (relation) => graphNodeIds.has(relation.sourceNodeId) && graphNodeIds.has(relation.targetNodeId)
  );

  return {
    teamName: text.organizationMap,
    teamColor: viewModel.rootNode?.color,
    isAlive: viewModel.stats.onlineTeamCount > 0,
    groupFrames: buildOrganizationGroupFrames(viewModel, context, text),
    nodes,
    edges: [
      ...buildContainmentEdges(viewModel).filter(
        (edge) =>
          visibleOrganizationNodeIds.has(edge.source) && visibleOrganizationNodeIds.has(edge.target)
      ),
      ...buildAgentOwnershipEdges(renderedAgentTeamNodes),
      ...buildManualRelationEdges(renderedManualRelations),
      ...buildCommunicationEdges(renderedCommunicationRelations),
    ].filter((edge) => graphNodeIds.has(edge.source) && graphNodeIds.has(edge.target)),
    particles: buildCommunicationParticles(
      renderedCommunicationRelations,
      context.maxParticleCount
    ),
    layout:
      ownerOrder.length > 0
        ? {
            version: 'stable-slots-v1',
            mode: context.layoutMode,
            showActivity: false,
            showLogs: false,
            showTasks: context.renderedAgentTeamIds.size > 0,
            fitTaskRowsToContent: true,
            alignGridColumns: true,
            ownerOrder,
            slotAssignments: buildLayoutSlotAssignments(viewModel, ownerOrder, context.layoutMode),
          }
        : undefined,
  };
}

export function getOrganizationNodeIdFromGraphRef(
  viewModel: OrganizationMapViewModel,
  ref: GraphDomainRef
): string | null {
  if (ref.kind === 'lead') {
    return ref.memberName;
  }
  if (ref.kind === 'member') {
    return ref.memberName;
  }
  if (ref.kind === 'task') {
    return viewModel.teamNodes.find((node) => node.team?.teamName === ref.teamName)?.id ?? null;
  }
  if (ref.kind === 'crossteam') {
    return (
      viewModel.teamNodes.find((node) => node.team?.teamName === ref.externalTeamName)?.id ?? null
    );
  }
  const firstTeam = viewModel.teamNodes.find((node) => node.team?.teamName === ref.teamName);
  return firstTeam?.id ?? null;
}
