/**
 * TeamGraphOverlay — full-screen overlay showing the agent graph.
 * Follows the exact ProjectEditorOverlay pattern (lazy-loaded, fixed z-50).
 */

import { useCallback, useState } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { TerminalWorkspaceFloatingLauncher } from '@features/terminal-workspace/renderer';
import { TeamSidebarHost } from '@renderer/components/team/sidebar/TeamSidebarHost';

import { useGraphMessagesPanel } from '../hooks/useGraphMessagesPanel';
import { useGraphSidebarVisibility } from '../hooks/useGraphSidebarVisibility';
import { useGraphSurfaceInteractions } from '../hooks/useGraphSurfaceInteractions';
import { useTeamGraphAdapter } from '../hooks/useTeamGraphAdapter';
import { useTeamGraphSurfaceActions } from '../hooks/useTeamGraphSurfaceActions';

import { GraphActivityHud } from './GraphActivityHud';
import { GraphBlockingEdgePopover } from './GraphBlockingEdgePopover';
import { GraphMemberLogPreviewHud } from './GraphMemberLogPreviewHud';
import { GraphNodePopover } from './GraphNodePopover';
import { GraphProvisioningHud } from './GraphProvisioningHud';
import { GraphTransientHandoffHud } from './GraphTransientHandoffHud';

import type {
  GraphDomainRef,
  GraphEventPort,
  TransientHandoffCard,
} from '@claude-teams/agent-graph';

export interface TeamGraphOverlayProps {
  teamName: string;
  onClose: () => void;
  onPinAsTab?: () => void;
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  messagesPanelEnabled?: boolean;
}

export const TeamGraphOverlay = ({
  teamName,
  onClose,
  onPinAsTab,
  sidebarVisible,
  onToggleSidebar,
  messagesPanelEnabled = true,
}: TeamGraphOverlayProps): React.JSX.Element => {
  const graphData = useTeamGraphAdapter(teamName);
  const {
    openTeamPage: openTeamTab,
    commitOwnerSlotDrop,
    commitOwnerGridOrderDrop,
    setLayoutMode,
  } = useTeamGraphSurfaceActions(teamName);
  const { sidebarVisible: persistedSidebarVisible, toggleSidebarVisible } =
    useGraphSidebarVisibility();
  const interactions = useGraphSurfaceInteractions(teamName);
  const [messagesPanelMountPoint, setMessagesPanelMountPoint] = useState<HTMLDivElement | null>(
    null
  );
  const effectiveSidebarVisible = sidebarVisible ?? persistedSidebarVisible;
  const handleToggleSidebar = onToggleSidebar ?? toggleSidebarVisible;
  const graphMessagesPanel = useGraphMessagesPanel({
    teamName,
    enabled: messagesPanelEnabled,
    mountPoint: messagesPanelMountPoint,
    onOpenMemberProfile: interactions.openMemberProfile,
    onOpenTaskDetail: interactions.openTaskDetail,
  });
  const openTeamPage = useCallback(() => {
    openTeamTab();
    onClose();
  }, [onClose, openTeamTab]);
  const openCreateTask = useCallback(() => {
    interactions.openCreateTask('');
  }, [interactions]);
  const events: GraphEventPort = {
    onNodeDoubleClick: useCallback(
      (ref: GraphDomainRef) => {
        if (ref.kind === 'task') interactions.openTaskDetail(ref.taskId);
        else if (ref.kind === 'member') interactions.openMemberProfile(ref.memberName);
      },
      [interactions]
    ),
    onSendMessage: interactions.openSendMessage,
    onOpenTaskDetail: interactions.openTaskDetail,
    onOpenMemberProfile: useCallback(
      (memberName: string) => interactions.openMemberProfile(memberName),
      [interactions]
    ),
  };

  return (
    <div className="fixed inset-0 z-50 flex overflow-hidden" style={{ background: '#050510' }}>
      {effectiveSidebarVisible ? (
        <TeamSidebarHost teamName={teamName} surface="graph-overlay" isActive isFocused />
      ) : null}
      <GraphView
        data={graphData}
        events={events}
        isSurfaceActive
        onRequestClose={onClose}
        onRequestPinAsTab={onPinAsTab}
        onOpenTeamPage={openTeamPage}
        onCreateTask={openCreateTask}
        onToggleSidebar={handleToggleSidebar}
        isSidebarVisible={effectiveSidebarVisible}
        renderTopToolbarContent={() => <GraphProvisioningHud teamName={teamName} />}
        onLayoutModeChange={setLayoutMode}
        onOwnerSlotDrop={commitOwnerSlotDrop}
        onOwnerGridOrderDrop={commitOwnerGridOrderDrop}
        className="team-graph-view min-w-0 flex-1"
        renderHud={(hudProps) => {
          const extraHudProps = hudProps as typeof hudProps & {
            getViewportSize?: () => { width: number; height: number };
            getActivityWorldRect?: (ownerNodeId: string) => {
              left: number;
              top: number;
              right: number;
              bottom: number;
              width: number;
              height: number;
            } | null;
            getLogWorldRect?: (ownerNodeId: string) => {
              left: number;
              top: number;
              right: number;
              bottom: number;
              width: number;
              height: number;
            } | null;
            getCameraZoom?: () => number;
            getTransientHandoffSnapshot?: (options?: {
              focusNodeIds?: ReadonlySet<string> | null;
              focusEdgeIds?: ReadonlySet<string> | null;
            }) => {
              cards: TransientHandoffCard[];
              time: number;
            };
            worldToScreen?: (x: number, y: number) => { x: number; y: number };
            getNodeWorldPosition?: (nodeId: string) => { x: number; y: number } | null;
            focusEdgeIds?: ReadonlySet<string> | null;
          };
          const { getViewportSize, focusNodeIds, filters } = extraHudProps;

          return (
            <>
              <GraphTransientHandoffHud
                teamName={teamName}
                getTransientHandoffSnapshot={extraHudProps.getTransientHandoffSnapshot}
                getCameraZoom={extraHudProps.getCameraZoom}
                worldToScreen={extraHudProps.worldToScreen}
                getNodeWorldPosition={extraHudProps.getNodeWorldPosition}
                focusNodeIds={focusNodeIds}
                focusEdgeIds={extraHudProps.focusEdgeIds ?? null}
              />
              <GraphActivityHud
                teamName={teamName}
                nodes={graphData.nodes}
                getActivityWorldRect={extraHudProps.getActivityWorldRect}
                getCameraZoom={extraHudProps.getCameraZoom}
                worldToScreen={extraHudProps.worldToScreen}
                getNodeWorldPosition={extraHudProps.getNodeWorldPosition}
                getViewportSize={getViewportSize}
                focusNodeIds={focusNodeIds}
                enabled={filters?.showActivity ?? true}
                showConnectors={filters?.showEdges ?? false}
                onOpenTaskDetail={interactions.openTaskDetail}
                onOpenMemberProfile={interactions.openMemberProfile}
              />
              <GraphMemberLogPreviewHud
                teamName={teamName}
                nodes={graphData.nodes}
                getLogWorldRect={extraHudProps.getLogWorldRect}
                getCameraZoom={extraHudProps.getCameraZoom}
                worldToScreen={extraHudProps.worldToScreen}
                getViewportSize={getViewportSize}
                focusNodeIds={focusNodeIds}
                enabled={filters?.showLogs ?? true}
                onOpenMemberProfile={interactions.openMemberProfile}
              />
            </>
          );
        }}
        renderEdgeOverlay={({ edge, sourceNode, targetNode, onClose: closeEdge, onSelectNode }) => (
          <GraphBlockingEdgePopover
            teamName={teamName}
            edge={edge}
            sourceNode={sourceNode}
            targetNode={targetNode}
            onClose={closeEdge}
            onSelectNode={onSelectNode}
            onOpenTaskDetail={interactions.openTaskDetail}
          />
        )}
        renderOverlay={({ node, onClose: closePopover }) => (
          <GraphNodePopover
            node={node}
            teamName={teamName}
            onClose={closePopover}
            onSendMessage={(name) => {
              interactions.openSendMessage(name);
              closePopover();
            }}
            onCreateTask={interactions.openCreateTask}
            onOpenTaskDetail={(id) => {
              interactions.openTaskDetail(id);
              closePopover();
            }}
            onOpenMemberProfile={(name, options) => {
              interactions.openMemberProfile(name, options);
              closePopover();
            }}
            onStartTask={interactions.onStartTask}
            onCompleteTask={interactions.onCompleteTask}
            onApproveTask={interactions.onApproveTask}
            onRequestReview={interactions.onRequestReview}
            onRequestChanges={interactions.onRequestChanges}
            onCancelTask={interactions.onCancelTask}
            onMoveBackToDone={interactions.onMoveBackToDone}
            onViewChanges={interactions.openTaskChanges}
            onDeleteTask={interactions.onDeleteTask}
          />
        )}
      />
      {messagesPanelEnabled ? (
        <div
          ref={setMessagesPanelMountPoint}
          className="pointer-events-none absolute inset-0 z-30"
        />
      ) : null}
      {graphMessagesPanel}
      <TerminalWorkspaceFloatingLauncher
        teamName={teamName}
        buttonTestId="open-terminal-floating-button-graph-overlay"
      />
      {interactions.dialogs}
    </div>
  );
};
