import { useCallback, useEffect, useMemo, useState } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { useAppTranslation } from '@features/localization/renderer';
import { Plus } from 'lucide-react';

import {
  buildOrganizationGraphData,
  getOrganizationNodeIdFromGraphRef,
} from '../adapters/organizationGraphData';
import { buildOrganizationGraphFocusState } from '../adapters/organizationGraphFocus';
import { getOrganizationIdForNodeId } from '../adapters/organizationMapViewModel';

import { OrgGraphFocusHud } from './OrgGraphFocusHud';
import { OrgGraphToolbar } from './OrgGraphToolbar';
import { OrgMapLegendHud } from './OrgMapLegendHud';
import { OrgOverviewHud } from './OrgOverviewHud';

import type { OrganizationPlacementSelection } from '../../contracts';
import type { OrganizationGraphFocusMode } from '../adapters/organizationGraphFocus';
import type { OrganizationMapViewModel } from '../adapters/organizationMapViewModel';
import type {
  GraphControlRenderProps,
  GraphDomainRef,
  GraphEdge,
  GraphEventPort,
  GraphGroupFrameScreenPlacement,
  GraphLayoutMode,
  GraphNode,
} from '@claude-teams/agent-graph';

type OrganizationRelationViewMode = 'structure' | 'relations';
type OrganizationGraphViewMode = 'overview' | 'hierarchy' | OrganizationRelationViewMode;

interface OrgGraphSurfaceProps {
  viewModel: OrganizationMapViewModel;
  isActive: boolean;
  collapsedNodeIds: ReadonlySet<string>;
  layoutMode: GraphLayoutMode;
  selectedNodeId: string | null;
  showSelectedTeamDetails?: boolean;
  onLayoutModeChange: (mode: GraphLayoutMode) => void;
  onSelectNode: (nodeId: string | null) => void;
  onRevealNode: (nodeId: string) => void;
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
  onRevealNode,
  onToggleNodeCollapse,
  onCreateTeamHere,
}: OrgGraphSurfaceProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [relationViewMode, setRelationViewMode] =
    useState<OrganizationRelationViewMode>('structure');
  const [isOverviewMode, setIsOverviewMode] = useState(false);
  const [focusMode, setFocusMode] = useState<OrganizationGraphFocusMode>('context');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isMinimapVisible, setIsMinimapVisible] = useState(true);
  const [revealNodeRequest, setRevealNodeRequest] = useState<{
    nodeId: string;
    requestId: number;
  } | null>(null);
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
      groupSummary: (teamCount: number, activeTeamCount: number, taskCount: number) =>
        t('organizations.graph.canvas.groupSummary', {
          teamCount,
          activeTeamCount,
          taskCount,
        }),
      teamSummary: (status: string, activeTaskCount: number, taskCount: number) =>
        t('organizations.graph.canvas.teamSummary', { status, activeTaskCount, taskCount }),
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
  const organizationFocus = useMemo(
    () => buildOrganizationGraphFocusState(viewModel, graphData, selectedNodeId, focusMode),
    [focusMode, graphData, selectedNodeId, viewModel]
  );
  const relationFocus = useMemo(
    () => buildRelationsFocus(relationViewMode, graphData),
    [graphData, relationViewMode]
  );
  const effectiveFocus = selectedNodeId ? organizationFocus : relationFocus;
  const displayedGraphData = useMemo(
    () => buildRelationModeGraphData(relationViewMode, graphData, effectiveFocus.focusNodeIds),
    [effectiveFocus.focusNodeIds, graphData, relationViewMode]
  );
  const activeViewMode: OrganizationGraphViewMode = isOverviewMode
    ? 'overview'
    : relationViewMode === 'relations'
      ? 'relations'
      : layoutMode === 'hierarchical'
        ? 'hierarchy'
        : 'structure';
  const viewModes = useMemo(
    () =>
      [
        { mode: 'overview', label: t('organizations.graph.view.overview') },
        { mode: 'hierarchy', label: t('organizations.graph.view.hierarchy') },
        { mode: 'structure', label: t('organizations.graph.view.structure') },
        { mode: 'relations', label: t('organizations.graph.view.relations') },
      ] as const,
    [t]
  );
  const changeViewMode = useCallback(
    (mode: OrganizationGraphViewMode): void => {
      if (mode === 'overview') {
        setIsOverviewMode(true);
        setRelationViewMode('structure');
        return;
      }
      setIsOverviewMode(false);
      if (mode === 'hierarchy') {
        setRelationViewMode('structure');
        if (layoutMode !== 'hierarchical') onLayoutModeChange('hierarchical');
        return;
      }
      setRelationViewMode(mode);
      if (layoutMode !== 'grid-under-lead') onLayoutModeChange('grid-under-lead');
    },
    [layoutMode, onLayoutModeChange]
  );
  const createTeamFrameId = useMemo(
    () => getCreateTeamFrameId(viewModel, selectedNodeId),
    [selectedNodeId, viewModel]
  );
  const selectNode = useCallback(
    (nodeId: string | null, reveal = false): void => {
      setFocusMode('context');
      if (nodeId && reveal) {
        onRevealNode(nodeId);
        setRevealNodeRequest((current) => ({
          nodeId,
          requestId: (current?.requestId ?? 0) + 1,
        }));
        return;
      }
      onSelectNode(nodeId);
    },
    [onRevealNode, onSelectNode]
  );
  const selectNodeFromHud = useCallback(
    (nodeId: string | null, reveal = false): void => {
      if (activeViewMode === 'overview' && nodeId) changeViewMode('structure');
      selectNode(nodeId, reveal);
    },
    [activeViewMode, changeViewMode, selectNode]
  );
  const graphViewData = useMemo(
    () =>
      activeViewMode === 'overview'
        ? {
            ...displayedGraphData,
            nodes: [],
            edges: [],
            particles: [],
            groupFrames: [],
            layout: undefined,
          }
        : displayedGraphData,
    [activeViewMode, displayedGraphData]
  );
  const events = useMemo<GraphEventPort>(
    () => ({
      onNodeClick: (ref: GraphDomainRef) => {
        selectNode(getOrganizationNodeIdFromGraphRef(viewModel, ref));
      },
      onNodeDoubleClick: (ref: GraphDomainRef) => {
        const nodeId = getOrganizationNodeIdFromGraphRef(viewModel, ref);
        selectNode(nodeId);
        if (
          nodeId &&
          nodeId !== viewModel.rootNode?.id &&
          (viewModel.childNodeIdsByParentId.get(nodeId)?.length ?? 0) > 0
        ) {
          onToggleNodeCollapse(nodeId);
        }
      },
      onGroupFrameClick: (frame) => {
        selectNode(frame.id);
      },
      onGroupFrameDoubleClick: (frame) => {
        onToggleNodeCollapse(frame.id);
      },
      onEdgeClick: () => {
        selectNode(null);
      },
      onBackgroundClick: () => selectNode(null),
    }),
    [onToggleNodeCollapse, selectNode, viewModel]
  );

  const renderControls = useCallback(
    (controls: GraphControlRenderProps): React.ReactNode => (
      <OrgGraphToolbar
        {...controls}
        activeViewMode={activeViewMode}
        viewModes={viewModes}
        isSearchOpen={isSearchOpen}
        isMinimapVisible={isMinimapVisible}
        canReset={
          Boolean(selectedNodeId) ||
          focusMode !== 'context' ||
          isSearchOpen ||
          collapsedNodeIds.size > 0 ||
          activeViewMode !== 'hierarchy' ||
          !controls.filters.showTasks ||
          !controls.filters.showEdges
        }
        onViewModeChange={changeViewMode}
        onSearchToggle={() => setIsSearchOpen((value) => !value)}
        onMinimapToggle={() => setIsMinimapVisible((value) => !value)}
        onReset={() => {
          setFocusMode('context');
          setIsSearchOpen(false);
          selectNode(null);
          [...collapsedNodeIds].forEach(onToggleNodeCollapse);
          changeViewMode('hierarchy');
          controls.onFiltersChange({
            ...controls.filters,
            showTasks: true,
            showEdges: true,
            paused: false,
          });
          controls.onZoomToFit();
        }}
        labels={{
          search: t('organizations.graph.focus.searchLabel'),
          filters: 'Фильтры карты',
          fit: 'Смысловой обзор',
          minimap: t('organizations.graph.canvas.minimap'),
          reset: 'Сбросить поиск, фокус и фильтры',
          tasks: 'Задачи',
          connections: 'Связи',
          animation: 'Анимация',
        }}
      />
    ),
    [
      activeViewMode,
      changeViewMode,
      collapsedNodeIds,
      focusMode,
      isMinimapVisible,
      isSearchOpen,
      onToggleNodeCollapse,
      selectNode,
      selectedNodeId,
      t,
      viewModes,
    ]
  );

  return (
    <GraphView
      data={graphViewData}
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
        showDotGrid: true,
        showStarField: false,
        showSpaceEffects: false,
        bloomIntensity: 0.25,
      }}
      showMinimap={activeViewMode !== 'overview' && isMinimapVisible}
      minimapLabel={t('organizations.graph.canvas.minimap')}
      focusNodeIds={activeViewMode === 'overview' ? null : effectiveFocus.focusNodeIds}
      focusEdgeIds={activeViewMode === 'overview' ? null : effectiveFocus.focusEdgeIds}
      focusOverridesSelection={Boolean(selectedNodeId)}
      revealNodeRequest={revealNodeRequest}
      renderControls={renderControls}
      renderOverlay={renderNodeOverlay}
      renderEdgeOverlay={(overlayProps) => renderEdgeOverlay(overlayProps, edgeOverlayText)}
      renderHud={({ getGroupFrameScreenPlacements, getViewportSize }) => (
        <>
          <OrgGraphFocusHud
            viewModel={viewModel}
            selectedNodeId={selectedNodeId}
            focusMode={focusMode}
            connectedTeamCount={organizationFocus.connectedTeamCount}
            collapsedNodeIds={collapsedNodeIds}
            onFocusModeChange={setFocusMode}
            onSelectNode={selectNodeFromHud}
            onToggleNodeCollapse={onToggleNodeCollapse}
            isSearchOpen={isSearchOpen}
            onSearchOpenChange={setIsSearchOpen}
            hideSearchTrigger
          />
          {activeViewMode === 'overview' ? null : relationViewMode === 'relations' ? (
            <OrgRelationLegendHud mode={relationViewMode} />
          ) : (
            <OrgMapLegendHud />
          )}
          {activeViewMode === 'overview' ? (
            <OrgOverviewHud viewModel={viewModel} onSelectNode={selectNodeFromHud} />
          ) : null}
          {activeViewMode !== 'overview' && onCreateTeamHere ? (
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
