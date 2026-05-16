/**
 * TeamGraphOverlay — full-screen overlay showing the agent graph.
 * Follows the exact ProjectEditorOverlay pattern (lazy-loaded, fixed z-50).
 */

import { useCallback, useMemo, useState } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { TeamSidebarHost } from '@renderer/components/team/sidebar/TeamSidebarHost';

import { useGraphCreateTaskDialog } from '../hooks/useGraphCreateTaskDialog';
import { useGraphMessagesPanel } from '../hooks/useGraphMessagesPanel';
import { useGraphSidebarVisibility } from '../hooks/useGraphSidebarVisibility';
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
import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';

export interface TeamGraphOverlayProps {
  teamName: string;
  onClose: () => void;
  onPinAsTab?: () => void;
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  messagesPanelEnabled?: boolean;
  onSendMessage?: (memberName: string) => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenMemberProfile?: (
    memberName: string,
    options?: {
      initialTab?: MemberDetailTab;
      initialActivityFilter?: MemberActivityFilter;
    }
  ) => void;
}

export const TeamGraphOverlay = ({
  teamName,
  onClose,
  onPinAsTab,
  sidebarVisible,
  onToggleSidebar,
  messagesPanelEnabled = true,
  onSendMessage,
  onOpenTaskDetail,
  onOpenMemberProfile,
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
  const { dialog: createTaskDialog, openCreateTaskDialog } = useGraphCreateTaskDialog(teamName);
  const [messagesPanelMountPoint, setMessagesPanelMountPoint] = useState<HTMLDivElement | null>(
    null
  );
  const effectiveSidebarVisible = sidebarVisible ?? persistedSidebarVisible;
  const handleToggleSidebar = onToggleSidebar ?? toggleSidebarVisible;
  const graphMessagesPanel = useGraphMessagesPanel({
    teamName,
    enabled: messagesPanelEnabled,
    mountPoint: messagesPanelMountPoint,
    onOpenMemberProfile: (memberName) => onOpenMemberProfile?.(memberName),
    onOpenTaskDetail: (taskId) => onOpenTaskDetail?.(taskId),
  });

  // Task action dispatchers (same pattern as TeamGraphTab)
  const dispatchTaskAction = useCallback(
    (action: string) => (taskId: string) =>
      window.dispatchEvent(new CustomEvent(`graph:${action}`, { detail: { teamName, taskId } })),
    [teamName]
  );
  const taskActions = useMemo(
    () => ({
      onStartTask: dispatchTaskAction('start-task'),
      onCompleteTask: dispatchTaskAction('complete-task'),
      onApproveTask: dispatchTaskAction('approve-task'),
      onRequestReview: dispatchTaskAction('request-review'),
      onRequestChanges: dispatchTaskAction('request-changes'),
      onCancelTask: dispatchTaskAction('cancel-task'),
      onMoveBackToDone: dispatchTaskAction('move-back-to-done'),
      onDeleteTask: dispatchTaskAction('delete-task'),
    }),
    [dispatchTaskAction]
  );
  const openTeamPage = useCallback(() => {
    openTeamTab();
    onClose();
  }, [onClose, openTeamTab]);
  const openCreateTask = useCallback(() => {
    openCreateTaskDialog('');
  }, [openCreateTaskDialog]);
  const events: GraphEventPort = {
    onNodeDoubleClick: useCallback(
      (ref: GraphDomainRef) => {
        if (ref.kind === 'task') onOpenTaskDetail?.(ref.taskId);
        else if (ref.kind === 'member') onOpenMemberProfile?.(ref.memberName);
      },
      [onOpenTaskDetail, onOpenMemberProfile]
    ),
    onSendMessage: useCallback(
      (memberName: string) => onSendMessage?.(memberName),
      [onSendMessage]
    ),
    onOpenTaskDetail: useCallback(
      (taskId: string) => onOpenTaskDetail?.(taskId),
      [onOpenTaskDetail]
    ),
    onOpenMemberProfile: useCallback(
      (memberName: string) => onOpenMemberProfile?.(memberName),
      [onOpenMemberProfile]
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
                onOpenTaskDetail={onOpenTaskDetail}
                onOpenMemberProfile={onOpenMemberProfile}
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
                onOpenMemberProfile={onOpenMemberProfile}
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
            onOpenTaskDetail={onOpenTaskDetail}
          />
        )}
        renderOverlay={({ node, onClose: closePopover }) => (
          <GraphNodePopover
            node={node}
            teamName={teamName}
            onClose={closePopover}
            onSendMessage={(name) => {
              onSendMessage?.(name);
              closePopover();
            }}
            onCreateTask={openCreateTaskDialog}
            onOpenTaskDetail={(id) => {
              onOpenTaskDetail?.(id);
              closePopover();
            }}
            onOpenMemberProfile={(name) => {
              onOpenMemberProfile?.(name);
              closePopover();
            }}
            {...taskActions}
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
      {createTaskDialog}
    </div>
  );
};
