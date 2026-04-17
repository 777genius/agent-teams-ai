/**
 * TeamGraphOverlay — full-screen overlay showing the agent graph.
 * Follows the exact ProjectEditorOverlay pattern (lazy-loaded, fixed z-50).
 */

import { useCallback, useMemo } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { TeamSidebarHost } from '@renderer/components/team/sidebar/TeamSidebarHost';

import { useGraphCreateTaskDialog } from '../hooks/useGraphCreateTaskDialog';
import { useGraphSidebarVisibility } from '../hooks/useGraphSidebarVisibility';
import { useTeamGraphAdapter } from '../hooks/useTeamGraphAdapter';
import { useTeamGraphSlotReset } from '../hooks/useTeamGraphSlotReset';
import { useTeamGraphSurfaceActions } from '../hooks/useTeamGraphSurfaceActions';

import { GraphActivityHud } from './GraphActivityHud';
import { GraphBlockingEdgePopover } from './GraphBlockingEdgePopover';
import { GraphNodePopover } from './GraphNodePopover';
import { GraphProvisioningHud } from './GraphProvisioningHud';

import type { GraphDomainRef, GraphEventPort } from '@claude-teams/agent-graph';
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
  onSendMessage,
  onOpenTaskDetail,
  onOpenMemberProfile,
}: TeamGraphOverlayProps): React.JSX.Element => {
  const graphData = useTeamGraphAdapter(teamName);
  const { openTeamPage: openTeamTab, commitOwnerSlotDrop } = useTeamGraphSurfaceActions(teamName);
  const { sidebarVisible: persistedSidebarVisible, toggleSidebarVisible } =
    useGraphSidebarVisibility();
  const { dialog: createTaskDialog, openCreateTaskDialog } = useGraphCreateTaskDialog(teamName);
  const effectiveSidebarVisible = sidebarVisible ?? persistedSidebarVisible;
  const handleToggleSidebar = onToggleSidebar ?? toggleSidebarVisible;

  useTeamGraphSlotReset(teamName);

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
        onOwnerSlotDrop={commitOwnerSlotDrop}
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
            getCameraZoom?: () => number;
            worldToScreen?: (x: number, y: number) => { x: number; y: number };
            getNodeWorldPosition?: (nodeId: string) => { x: number; y: number } | null;
          };
          const { getViewportSize, focusNodeIds } = extraHudProps;

          return (
            <>
              <GraphActivityHud
                teamName={teamName}
                nodes={graphData.nodes}
                getActivityWorldRect={extraHudProps.getActivityWorldRect}
                getCameraZoom={extraHudProps.getCameraZoom}
                worldToScreen={extraHudProps.worldToScreen}
                getNodeWorldPosition={extraHudProps.getNodeWorldPosition}
                getViewportSize={getViewportSize}
                focusNodeIds={focusNodeIds}
                onOpenTaskDetail={onOpenTaskDetail}
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
      {createTaskDialog}
    </div>
  );
};
