import { useEffect, useMemo, useState } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { useAppTranslation } from '@features/localization/renderer';
import { Plus } from 'lucide-react';

import {
  buildOrganizationGraphData,
  getOrganizationNodeIdFromGraphRef,
} from '../adapters/organizationGraphData';
import { getOrganizationIdForNodeId } from '../adapters/organizationMapViewModel';

import type { OrganizationPlacementSelection } from '../../contracts';
import type { OrganizationMapViewModel } from '../adapters/organizationMapViewModel';
import type {
  GraphDomainRef,
  GraphEdge,
  GraphEventPort,
  GraphGroupFrameScreenPlacement,
  GraphLayoutMode,
  GraphNode,
} from '@claude-teams/agent-graph';

type OrganizationRelationViewMode = 'structure' | 'relations';

interface OrgGraphSurfaceProps {
  viewModel: OrganizationMapViewModel;
  isActive: boolean;
  collapsedNodeIds: ReadonlySet<string>;
  layoutMode: GraphLayoutMode;
  selectedNodeId: string | null;
  showSelectedTeamDetails?: boolean;
  onLayoutModeChange: (mode: GraphLayoutMode) => void;
  onSelectNode: (nodeId: string | null) => void;
  onToggleNodeCollapse: (nodeId: string) => void;
  onCreateTeamHere?: (placement: OrganizationPlacementSelection) => void;
}

interface GroupCreateButton {
  frameId: string;
  label: string;
  left: number;
  top: number;
  placement: OrganizationPlacementSelection;
}

const MIN_CREATE_BUTTON_FRAME_WIDTH = 112;
const MIN_CREATE_BUTTON_FRAME_HEIGHT = 60;
const RELATION_EDGE_TYPES = new Set<GraphEdge['type']>(['blocking', 'related', 'message']);
function isRelationEdge(edge: GraphEdge): boolean {
  return RELATION_EDGE_TYPES.has(edge.type);
}

function buildRelationsFocus(
  mode: OrganizationRelationViewMode,
  graphData: ReturnType<typeof buildOrganizationGraphData>
): { focusNodeIds: ReadonlySet<string> | null; focusEdgeIds: ReadonlySet<string> | null } {
  if (mode === 'structure') {
    return { focusNodeIds: null, focusEdgeIds: null };
  }

  const relationEdges = graphData.edges.filter(isRelationEdge);
  if (relationEdges.length === 0) {
    return { focusNodeIds: null, focusEdgeIds: null };
  }

  return {
    focusNodeIds: new Set(relationEdges.flatMap((edge) => [edge.source, edge.target])),
    focusEdgeIds: new Set(relationEdges.map((edge) => edge.id)),
  };
}

function buildRelationModeGraphData(
  mode: OrganizationRelationViewMode,
  graphData: ReturnType<typeof buildOrganizationGraphData>,
  focusNodeIds: ReadonlySet<string> | null
): ReturnType<typeof buildOrganizationGraphData> {
  if (mode === 'structure') {
    return graphData;
  }

  const relationEdgeIds = new Set(graphData.edges.filter(isRelationEdge).map((edge) => edge.id));
  const visibleRelationEdgeIds = relationEdgeIds;
  const relationNodeIds = new Set(
    graphData.edges
      .filter((edge) => visibleRelationEdgeIds.has(edge.id))
      .flatMap((edge) => [edge.source, edge.target])
  );
  const visibleNodeIds = new Set<string>([...relationNodeIds, ...(focusNodeIds ?? [])]);
  const visibleGraphNodes = graphData.nodes.filter(
    (node) => node.layoutOnly || (node.kind === 'member' && visibleNodeIds.has(node.id))
  );
  const visibleGraphNodeIds = new Set(visibleGraphNodes.map((node) => node.id));
  const groupFrames = (graphData.groupFrames ?? [])
    .map((frame) => ({
      ...frame,
      nodeIds: frame.nodeIds.filter((nodeId) => visibleGraphNodeIds.has(nodeId)),
    }))
    .filter((frame) => frame.nodeIds.length > 0);
  const layout = graphData.layout
    ? {
        ...graphData.layout,
        showTasks: false,
        ownerOrder: graphData.layout.ownerOrder.filter((nodeId) => visibleGraphNodeIds.has(nodeId)),
        slotAssignments: Object.fromEntries(
          Object.entries(graphData.layout.slotAssignments).filter(([nodeId]) =>
            visibleGraphNodeIds.has(nodeId)
          )
        ),
      }
    : undefined;

  return {
    ...graphData,
    groupFrames,
    nodes: visibleGraphNodes,
    edges: graphData.edges
      .filter((edge) => visibleRelationEdgeIds.has(edge.id))
      .map((edge) => ({ ...edge, alwaysVisible: true })),
    particles: graphData.particles.filter((particle) =>
      visibleRelationEdgeIds.has(particle.edgeId)
    ),
    layout,
  };
}

function getCreateTeamFrameId(
  viewModel: OrganizationMapViewModel,
  selectedNodeId: string | null
): string | null {
  if (!selectedNodeId) {
    return null;
  }

  let candidateId: string | undefined = selectedNodeId;
  const selectedNode = viewModel.nodeById.get(selectedNodeId);
  if (selectedNode?.kind === 'team') {
    candidateId = viewModel.parentNodeIdByChildId.get(selectedNodeId);
  }

  while (candidateId) {
    if (resolveCreateTeamPlacement(viewModel, candidateId)) {
      return candidateId;
    }
    candidateId = viewModel.parentNodeIdByChildId.get(candidateId);
  }

  return null;
}

function resolveCreateTeamPlacement(
  viewModel: OrganizationMapViewModel,
  frameId: string
): OrganizationPlacementSelection | null {
  const node = viewModel.nodeById.get(frameId);
  if (!node || node.kind === 'team' || !node.structureUnitId) {
    return null;
  }

  const organizationId = getOrganizationIdForNodeId(viewModel, frameId);
  if (!organizationId) {
    return null;
  }

  return {
    organizationId,
    parentUnitId: node.structureUnitId,
  };
}

function areCreateButtonsEqual(
  leftButtons: readonly GroupCreateButton[],
  rightButtons: readonly GroupCreateButton[]
): boolean {
  if (leftButtons.length !== rightButtons.length) {
    return false;
  }

  return leftButtons.every((left, index) => {
    const right = rightButtons[index];
    return (
      right !== undefined &&
      left.frameId === right.frameId &&
      left.left === right.left &&
      left.top === right.top &&
      left.label === right.label &&
      left.placement.organizationId === right.placement.organizationId &&
      left.placement.parentUnitId === right.placement.parentUnitId
    );
  });
}

const OrgRelationLegendHud = ({
  mode,
}: {
  mode: OrganizationRelationViewMode;
}): React.JSX.Element | null => {
  if (mode === 'structure') {
    return null;
  }

  return (
    <div className="absolute bottom-4 left-4 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-medium text-[var(--color-text-muted)] drop-shadow-[0_1px_2px_rgba(0,0,0,0.7)]">
      {[
        ['#f59e0b', 'depends'],
        ['#22c55e', 'delegates'],
        ['#38bdf8', 'observes'],
        ['#94a3b8', 'communicates'],
        ['#8b9cff', 'messages'],
      ].map(([color, label]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 rounded-full" style={{ backgroundColor: color }} />
          {label}
        </span>
      ))}
    </div>
  );
};

const OrgGroupFrameCreateHud = ({
  viewModel,
  isActive,
  targetFrameId,
  getGroupFrameScreenPlacements,
  getViewportSize,
  onCreateTeamHere,
  getCreateTeamLabel,
}: {
  viewModel: OrganizationMapViewModel;
  isActive: boolean;
  targetFrameId: string | null;
  getGroupFrameScreenPlacements: () => GraphGroupFrameScreenPlacement[];
  getViewportSize: () => { width: number; height: number };
  onCreateTeamHere: (placement: OrganizationPlacementSelection) => void;
  getCreateTeamLabel: (label: string) => string;
}): React.JSX.Element => {
  const [buttons, setButtons] = useState<GroupCreateButton[]>([]);

  useEffect(() => {
    if (!isActive || !targetFrameId) {
      setButtons([]);
      return undefined;
    }

    let frameId = 0;
    const update = (): void => {
      const viewport = getViewportSize();
      const nextButtons = getGroupFrameScreenPlacements().flatMap((placement) => {
        const { bounds, frame } = placement;
        if (frame.id !== targetFrameId) {
          return [];
        }
        if (
          bounds.width < MIN_CREATE_BUTTON_FRAME_WIDTH ||
          bounds.height < MIN_CREATE_BUTTON_FRAME_HEIGHT ||
          bounds.right < 0 ||
          bounds.bottom < 0 ||
          bounds.left > viewport.width ||
          bounds.top > viewport.height
        ) {
          return [];
        }

        const createPlacement = resolveCreateTeamPlacement(viewModel, frame.id);
        if (!createPlacement) {
          return [];
        }

        return [
          {
            frameId: frame.id,
            label: frame.label,
            left: Math.round(
              Math.min(Math.max(bounds.left + 12, bounds.right - 40), viewport.width - 40)
            ),
            top: Math.round(Math.max(bounds.top + 12, 8)),
            placement: createPlacement,
          },
        ];
      });

      setButtons((current) =>
        areCreateButtonsEqual(current, nextButtons) ? current : nextButtons
      );
      frameId = window.requestAnimationFrame(update);
    };

    update();
    return () => window.cancelAnimationFrame(frameId);
  }, [getGroupFrameScreenPlacements, getViewportSize, isActive, targetFrameId, viewModel]);

  return (
    <>
      {buttons.map((button) => (
        <button
          key={button.frameId}
          type="button"
          aria-label={getCreateTeamLabel(button.label)}
          title={getCreateTeamLabel(button.label)}
          data-organization-map-create-team-frame-id={button.frameId}
          className="pointer-events-auto absolute flex size-7 items-center justify-center rounded-md border border-sky-300/45 bg-[var(--color-surface-overlay)] text-sky-100 shadow-lg shadow-black/30 backdrop-blur-sm transition-colors hover:border-sky-200 hover:bg-sky-500/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
          style={{ left: button.left, top: button.top }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCreateTeamHere(button.placement);
          }}
        >
          <Plus size={15} />
        </button>
      ))}
    </>
  );
};

function renderNodeOverlay({ node }: { node: GraphNode }): React.JSX.Element | null {
  if (node.kind === 'lead' || node.kind === 'member') {
    return null;
  }

  return (
    <div className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-3 text-xs shadow-xl">
      <div className="font-semibold text-[var(--color-text)]">{node.label}</div>
      {node.sublabel ? (
        <div className="mt-1 line-clamp-3 text-[var(--color-text-muted)]">{node.sublabel}</div>
      ) : null}
    </div>
  );
}

function renderEdgeOverlay(
  {
    edge,
    sourceNode,
    targetNode,
    onClose,
  }: {
    edge: GraphEdge;
    sourceNode: GraphNode | undefined;
    targetNode: GraphNode | undefined;
    onClose: () => void;
  },
  text: {
    runtimeMessages: string;
    manualRelation: string;
    close: string;
    messages: (count: number) => string;
    weight: (count: number) => string;
  }
): React.ReactNode {
  if (!isRelationEdge(edge)) {
    return null;
  }
  const isMessageEdge = edge.type === 'message';
  return (
    <div className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-3 text-xs shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-[var(--color-text)]">
            {isMessageEdge ? text.runtimeMessages : text.manualRelation}
          </div>
          <div className="mt-1 truncate text-[var(--color-text-muted)]">
            {sourceNode?.label ?? edge.source}
            {' -> '}
            {targetNode?.label ?? edge.target}
          </div>
        </div>
        <button
          type="button"
          aria-label={text.close}
          className="rounded-sm px-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
          onClick={onClose}
        >
          x
        </button>
      </div>
      {edge.label ? (
        <div className="mt-2 line-clamp-4 text-[var(--color-text-muted)]">{edge.label}</div>
      ) : null}
      {edge.aggregateCount ? (
        <div className="mt-2 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          {isMessageEdge ? text.messages(edge.aggregateCount) : text.weight(edge.aggregateCount)}
        </div>
      ) : null}
    </div>
  );
}

export const OrgGraphSurface = ({
  viewModel,
  isActive,
  collapsedNodeIds,
  layoutMode,
  selectedNodeId,
  showSelectedTeamDetails = true,
  onLayoutModeChange,
  onSelectNode,
  onToggleNodeCollapse,
  onCreateTeamHere,
}: OrgGraphSurfaceProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [relationViewMode, setRelationViewMode] =
    useState<OrganizationRelationViewMode>('structure');
  const edgeOverlayText = useMemo(
    () => ({
      runtimeMessages: t('organizations.graph.edgeOverlay.runtimeMessages'),
      manualRelation: t('organizations.graph.edgeOverlay.manualRelation'),
      close: t('organizations.graph.edgeOverlay.close'),
      messages: (count: number) => t('organizations.graph.edgeOverlay.messages', { count }),
      weight: (count: number) => t('organizations.graph.edgeOverlay.weight', { count }),
    }),
    [t]
  );
  const graphText = useMemo(
    () => ({
      organizationMap: t('organizations.graph.canvas.organizationMap'),
      allOrganizations: t('organizations.graph.canvas.allOrganizations'),
      unassignedTeams: t('organizations.graph.canvas.unassignedTeams'),
      agents: (count: number) => t('organizations.graph.canvas.agents', { count }),
      activeAgents: (count: number) => t('organizations.graph.canvas.activeAgents', { count }),
      teams: (count: number) => t('organizations.graph.canvas.teams', { count }),
      orgsAndTeams: (orgCount: number, teamCount: number) =>
        t('organizations.graph.canvas.orgsAndTeams', { orgCount, teamCount }),
      teamRole: (memberCount: number, activeCount: number) =>
        t('organizations.graph.canvas.teamRole', { memberCount, activeCount }),
      teamReference: t('organizations.graph.canvas.teamReference'),
      notFound: t('organizations.graph.canvas.notFound'),
      online: t('organizations.graph.canvas.online'),
      offline: t('organizations.graph.canvas.offline'),
      agentStatus: (status: 'active' | 'idle' | 'offline' | 'unknown') => {
        if (status === 'active') {
          return t('organizations.graph.canvas.agentStatus.active');
        }
        if (status === 'offline') {
          return t('organizations.graph.canvas.agentStatus.offline');
        }
        if (status === 'unknown') {
          return t('organizations.graph.canvas.agentStatus.unknown');
        }
        return t('organizations.graph.canvas.agentStatus.idle');
      },
    }),
    [t]
  );
  const graphData = useMemo(
    () =>
      buildOrganizationGraphData(viewModel, {
        collapsedNodeIds,
        layoutMode,
        selectedNodeId,
        showSelectedTeamDetails,
        text: graphText,
      }),
    [collapsedNodeIds, graphText, layoutMode, selectedNodeId, showSelectedTeamDetails, viewModel]
  );
  const relationFocus = useMemo(
    () => buildRelationsFocus(relationViewMode, graphData),
    [graphData, relationViewMode]
  );
  const displayedGraphData = useMemo(
    () => buildRelationModeGraphData(relationViewMode, graphData, relationFocus.focusNodeIds),
    [graphData, relationFocus.focusNodeIds, relationViewMode]
  );
  const relationToolbar = useMemo(
    () => (
      <div className="mx-auto flex max-w-full flex-col items-center gap-1">
        <div className="inline-flex max-w-full items-center rounded-lg border border-sky-300/15 bg-[var(--color-surface-overlay)] p-0.5 text-[11px] font-medium shadow-lg shadow-black/20 backdrop-blur-md">
          {(
            [
              ['structure', 'Structure'],
              ['relations', 'Relations'],
            ] as const
          ).map(([mode, label]) => {
            const active = relationViewMode === mode;
            return (
              <button
                key={mode}
                type="button"
                className={`h-6 rounded-md px-2.5 transition-colors ${
                  active
                    ? 'bg-sky-400/18 text-sky-100 shadow-sm shadow-sky-500/10'
                    : 'text-[var(--color-text-muted)] hover:bg-white/5 hover:text-[var(--color-text)]'
                }`}
                onClick={() => {
                  setRelationViewMode(mode);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    ),
    [relationViewMode]
  );
  const createTeamFrameId = useMemo(
    () => getCreateTeamFrameId(viewModel, selectedNodeId),
    [selectedNodeId, viewModel]
  );
  const events = useMemo<GraphEventPort>(
    () => ({
      onNodeClick: (ref: GraphDomainRef) => {
        onSelectNode(getOrganizationNodeIdFromGraphRef(viewModel, ref));
      },
      onNodeDoubleClick: (ref: GraphDomainRef) => {
        const nodeId = getOrganizationNodeIdFromGraphRef(viewModel, ref);
        onSelectNode(nodeId);
        if (
          nodeId &&
          nodeId !== viewModel.rootNode?.id &&
          (viewModel.childNodeIdsByParentId.get(nodeId)?.length ?? 0) > 0
        ) {
          onToggleNodeCollapse(nodeId);
        }
      },
      onGroupFrameClick: (frame) => {
        onSelectNode(frame.id);
      },
      onGroupFrameDoubleClick: (frame) => {
        onToggleNodeCollapse(frame.id);
      },
      onEdgeClick: () => {
        onSelectNode(null);
      },
      onBackgroundClick: () => onSelectNode(null),
    }),
    [onSelectNode, onToggleNodeCollapse, viewModel]
  );

  return (
    <GraphView
      data={displayedGraphData}
      events={events}
      className="size-full"
      suspendAnimation={!isActive}
      isSurfaceActive={isActive}
      config={{
        animationEnabled: true,
        showActivity: false,
        showLogs: false,
        showProcesses: false,
        showTasks: relationViewMode === 'structure',
        showEdges: true,
        showEdgeLabels: false,
        showHexGrid: false,
        showStarField: false,
        showSpaceEffects: false,
        bloomIntensity: 0.25,
      }}
      onLayoutModeChange={onLayoutModeChange}
      focusNodeIds={relationFocus.focusNodeIds}
      focusEdgeIds={relationFocus.focusEdgeIds}
      renderTopToolbarContent={() => relationToolbar}
      renderOverlay={renderNodeOverlay}
      renderEdgeOverlay={(overlayProps) => renderEdgeOverlay(overlayProps, edgeOverlayText)}
      renderHud={({ getGroupFrameScreenPlacements, getViewportSize }) => (
        <>
          <OrgRelationLegendHud mode={relationViewMode} />
          {onCreateTeamHere ? (
            <OrgGroupFrameCreateHud
              viewModel={viewModel}
              isActive={isActive}
              targetFrameId={createTeamFrameId}
              getGroupFrameScreenPlacements={getGroupFrameScreenPlacements}
              getViewportSize={getViewportSize}
              onCreateTeamHere={onCreateTeamHere}
              getCreateTeamLabel={(label) =>
                t('organizations.graph.actions.createTeamIn', { label })
              }
            />
          ) : null}
        </>
      )}
    />
  );
};
