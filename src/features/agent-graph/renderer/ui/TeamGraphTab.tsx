/**
 * TeamGraphTab — wraps GraphView for use as a dedicated tab.
 * Provides Fullscreen button that opens the overlay.
 */

import { lazy, Suspense, useCallback, useState } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { TerminalWorkspaceFloatingLauncher } from '@features/terminal-workspace/renderer';
import { TeamSidebarHost } from '@renderer/components/team/sidebar/TeamSidebarHost';
import { useTeamSidebarPortalSnapshot } from '@renderer/components/team/sidebar/TeamSidebarPortalManager';

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

const TeamGraphOverlay = lazy(() =>
  import('./TeamGraphOverlay').then((m) => ({ default: m.TeamGraphOverlay }))
);

export interface TeamGraphTabProps {
  teamName: string;
  isActive?: boolean;
  isPaneFocused?: boolean;
}

export const TeamGraphTab = ({
  teamName,
  isActive = true,
  isPaneFocused = false,
}: TeamGraphTabProps): React.JSX.Element => {
  const graphData = useTeamGraphAdapter(teamName, { active: isActive });
  const { openTeamPage, commitOwnerSlotDrop, commitOwnerGridOrderDrop, setLayoutMode } =
    useTeamGraphSurfaceActions(teamName);
  const [fullscreen, setFullscreen] = useState(false);
  const [messagesPanelMountPoint, setMessagesPanelMountPoint] = useState<HTMLDivElement | null>(
    null
  );
  const { sidebarVisible, toggleSidebarVisible } = useGraphSidebarVisibility();
  const sidebarSnapshot = useTeamSidebarPortalSnapshot();
  const hasSidebarSource = Boolean(sidebarSnapshot.activeSourceIdByTeam[teamName]);
  const effectiveSidebarVisible = sidebarVisible && hasSidebarSource;
  const interactions = useGraphSurfaceInteractions(teamName);
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
      (memberName: string) => {
        interactions.openMemberProfile(memberName);
      },
      [interactions]
    ),
  };
  const graphMessagesPanel = useGraphMessagesPanel({
    teamName,
    enabled: isActive && isPaneFocused && !fullscreen,
    mountPoint: messagesPanelMountPoint,
    onOpenMemberProfile: interactions.openMemberProfile,
    onOpenTaskDetail: interactions.openTaskDetail,
  });

  return (
    <div className="relative flex size-full overflow-hidden" style={{ background: '#050510' }}>
      {effectiveSidebarVisible ? (
        <TeamSidebarHost
          teamName={teamName}
          surface="graph-tab"
          isActive={isActive}
          isFocused={isPaneFocused}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <GraphView
          data={graphData}
          events={events}
          className="team-graph-view size-full"
          suspendAnimation={!isActive}
          isSurfaceActive={isActive}
          onRequestFullscreen={() => setFullscreen(true)}
          onOpenTeamPage={openTeamPage}
          onCreateTask={openCreateTask}
          onToggleSidebar={hasSidebarSource ? toggleSidebarVisible : undefined}
          isSidebarVisible={effectiveSidebarVisible}
          renderTopToolbarContent={() => (
            <GraphProvisioningHud teamName={teamName} enabled={isActive} />
          )}
          onLayoutModeChange={setLayoutMode}
          onOwnerSlotDrop={commitOwnerSlotDrop}
          onOwnerGridOrderDrop={commitOwnerGridOrderDrop}
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
                  enabled={isActive}
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
                  enabled={isActive && (filters?.showActivity ?? true)}
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
                  enabled={isActive && (filters?.showLogs ?? true)}
                  onOpenMemberProfile={interactions.openMemberProfile}
                />
              </>
            );
          }}
          renderEdgeOverlay={({ edge, sourceNode, targetNode, onClose, onSelectNode }) => (
            <GraphBlockingEdgePopover
              teamName={teamName}
              edge={edge}
              sourceNode={sourceNode}
              targetNode={targetNode}
              onClose={onClose}
              onSelectNode={onSelectNode}
              onOpenTaskDetail={interactions.openTaskDetail}
            />
          )}
          renderOverlay={({ node, onClose }) => (
            <GraphNodePopover
              node={node}
              teamName={teamName}
              onClose={onClose}
              onSendMessage={interactions.openSendMessage}
              onOpenTaskDetail={interactions.openTaskDetail}
              onOpenMemberProfile={interactions.openMemberProfile}
              onCreateTask={interactions.openCreateTask}
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
      </div>
      {isActive && isPaneFocused && !fullscreen ? (
        <div
          ref={setMessagesPanelMountPoint}
          className="pointer-events-none absolute inset-0 z-30"
        />
      ) : null}
      {graphMessagesPanel}
      <TerminalWorkspaceFloatingLauncher
        teamName={teamName}
        bottomOffset={53}
        buttonTestId="open-terminal-floating-button-graph"
        enabled={isActive && !fullscreen}
      />
      {interactions.dialogs}
      {fullscreen && (
        <Suspense fallback={null}>
          <TeamGraphOverlay
            teamName={teamName}
            onClose={() => setFullscreen(false)}
            sidebarVisible={effectiveSidebarVisible}
            onToggleSidebar={hasSidebarSource ? toggleSidebarVisible : undefined}
            messagesPanelEnabled={isActive && isPaneFocused}
          />
        </Suspense>
      )}
    </div>
  );
};
