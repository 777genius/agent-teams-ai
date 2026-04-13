/**
 * TeamGraphOverlay — full-screen overlay showing the agent graph.
 * Follows the exact ProjectEditorOverlay pattern (lazy-loaded, fixed z-50).
 */

import { useCallback, useMemo } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { TeamSidebarHost } from '@renderer/components/team/sidebar/TeamSidebarHost';
import { useStore } from '@renderer/store';

import { useTeamGraphAdapter } from '../adapters/useTeamGraphAdapter';

import { GraphActivityHud } from './GraphActivityHud';
import { GraphBlockingEdgePopover } from './GraphBlockingEdgePopover';
import { GraphNodePopover } from './GraphNodePopover';
import { GraphProvisioningHud } from './GraphProvisioningHud';
import { useGraphCreateTaskDialog } from './useGraphCreateTaskDialog';

import type { GraphDomainRef, GraphEventPort } from '@claude-teams/agent-graph';
import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';

export interface TeamGraphOverlayProps {
  teamName: string;
  onClose: () => void;
  onPinAsTab?: () => void;
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
  onSendMessage,
  onOpenTaskDetail,
  onOpenMemberProfile,
}: TeamGraphOverlayProps): React.JSX.Element => {
  const graphData = useTeamGraphAdapter(teamName);
  const { dialog: createTaskDialog, openCreateTaskDialog } = useGraphCreateTaskDialog(teamName);
  const leadNodeId = useMemo(
    () => graphData.nodes.find((node) => node.kind === 'lead')?.id ?? null,
    [graphData.nodes]
  );

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
    useStore.getState().openTeamTab(teamName);
    onClose();
  }, [onClose, teamName]);
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
      <TeamSidebarHost teamName={teamName} surface="graph-overlay" isActive isFocused />
      <GraphView
        data={graphData}
        events={events}
        onRequestClose={onClose}
        onRequestPinAsTab={onPinAsTab}
        onOpenTeamPage={openTeamPage}
        onCreateTask={openCreateTask}
        className="team-graph-view min-w-0 flex-1"
        renderHud={({
          getLaunchAnchorScreenPlacement,
          getActivityAnchorScreenPlacement,
          getNodeScreenPosition,
          focusNodeIds,
        }) => (
          <>
            <GraphActivityHud
              teamName={teamName}
              nodes={graphData.nodes}
              getActivityAnchorScreenPlacement={getActivityAnchorScreenPlacement}
              getNodeScreenPosition={getNodeScreenPosition}
              focusNodeIds={focusNodeIds}
              onOpenTaskDetail={onOpenTaskDetail}
              onOpenMemberProfile={onOpenMemberProfile}
            />
            <GraphProvisioningHud
              teamName={teamName}
              leadNodeId={leadNodeId}
              getLaunchAnchorScreenPlacement={getLaunchAnchorScreenPlacement}
            />
          </>
        )}
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
