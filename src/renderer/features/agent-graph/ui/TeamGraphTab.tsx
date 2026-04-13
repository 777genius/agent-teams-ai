/**
 * TeamGraphTab — wraps GraphView for use as a dedicated tab.
 * Provides Fullscreen button that opens the overlay.
 */

import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { TeamSidebarHost } from '@renderer/components/team/sidebar/TeamSidebarHost';
import { useStore } from '@renderer/store';

import { useTeamGraphAdapter } from '../adapters/useTeamGraphAdapter';

import { GraphActivityHud } from './GraphActivityHud';
import { GraphBlockingEdgePopover } from './GraphBlockingEdgePopover';
import { GraphNodePopover } from './GraphNodePopover';
import { GraphProvisioningHud } from './GraphProvisioningHud';
import { useGraphCreateTaskDialog } from './useGraphCreateTaskDialog';

import type { GraphDomainRef, GraphEventPort, GraphNode } from '@claude-teams/agent-graph';
import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';

const TeamGraphOverlay = lazy(() =>
  import('./TeamGraphOverlay').then((m) => ({ default: m.TeamGraphOverlay }))
);

export interface TeamGraphTabProps {
  teamName: string;
  isActive?: boolean;
  isPaneFocused?: boolean;
}

interface OpenProfileOptions {
  initialTab?: MemberDetailTab;
  initialActivityFilter?: MemberActivityFilter;
}

export const TeamGraphTab = ({
  teamName,
  isActive = true,
  isPaneFocused = false,
}: TeamGraphTabProps): React.JSX.Element => {
  const graphData = useTeamGraphAdapter(teamName);
  const leadNodeId = useMemo(
    () => graphData.nodes.find((node) => node.kind === 'lead')?.id ?? null,
    [graphData.nodes]
  );
  const [fullscreen, setFullscreen] = useState(false);
  const { dialog: createTaskDialog, openCreateTaskDialog } = useGraphCreateTaskDialog(teamName);

  // Typed event dispatchers (DRY — used in both events + renderOverlay)
  const dispatchOpenTask = useCallback(
    (taskId: string) =>
      window.dispatchEvent(new CustomEvent('graph:open-task', { detail: { teamName, taskId } })),
    [teamName]
  );
  const dispatchSendMessage = useCallback(
    (memberName: string) =>
      window.dispatchEvent(
        new CustomEvent('graph:send-message', { detail: { teamName, memberName } })
      ),
    [teamName]
  );
  const dispatchOpenProfile = useCallback(
    (memberName: string, options?: OpenProfileOptions) =>
      window.dispatchEvent(
        new CustomEvent('graph:open-profile', {
          detail: { teamName, memberName, ...options },
        })
      ),
    [teamName]
  );
  const openTeamPage = useCallback(() => {
    useStore.getState().openTeamTab(teamName);
  }, [teamName]);
  const openCreateTask = useCallback(() => {
    openCreateTaskDialog('');
  }, [openCreateTaskDialog]);

  // Task action dispatchers
  const dispatchTaskAction = useCallback(
    (action: string) => (taskId: string) =>
      window.dispatchEvent(new CustomEvent(`graph:${action}`, { detail: { teamName, taskId } })),
    [teamName]
  );
  const dispatchStartTask = useMemo(() => dispatchTaskAction('start-task'), [dispatchTaskAction]);
  const dispatchCompleteTask = useMemo(
    () => dispatchTaskAction('complete-task'),
    [dispatchTaskAction]
  );
  const dispatchApproveTask = useMemo(
    () => dispatchTaskAction('approve-task'),
    [dispatchTaskAction]
  );
  const dispatchRequestReview = useMemo(
    () => dispatchTaskAction('request-review'),
    [dispatchTaskAction]
  );
  const dispatchRequestChanges = useMemo(
    () => dispatchTaskAction('request-changes'),
    [dispatchTaskAction]
  );
  const dispatchCancelTask = useMemo(() => dispatchTaskAction('cancel-task'), [dispatchTaskAction]);
  const dispatchMoveBackToDone = useMemo(
    () => dispatchTaskAction('move-back-to-done'),
    [dispatchTaskAction]
  );
  const dispatchDeleteTask = useMemo(() => dispatchTaskAction('delete-task'), [dispatchTaskAction]);

  const events: GraphEventPort = {
    onNodeDoubleClick: useCallback(
      (ref: GraphDomainRef) => {
        if (ref.kind === 'task') dispatchOpenTask(ref.taskId);
        else if (ref.kind === 'member') dispatchOpenProfile(ref.memberName);
      },
      [dispatchOpenTask, dispatchOpenProfile]
    ),
    onSendMessage: dispatchSendMessage,
    onOpenTaskDetail: dispatchOpenTask,
    onOpenMemberProfile: useCallback(
      (memberName: string) => {
        dispatchOpenProfile(memberName);
      },
      [dispatchOpenProfile]
    ),
  };

  return (
    <div className="flex size-full overflow-hidden" style={{ background: '#050510' }}>
      <TeamSidebarHost
        teamName={teamName}
        surface="graph-tab"
        isActive={isActive}
        isFocused={isPaneFocused}
      />
      <div className="min-w-0 flex-1">
        <GraphView
          data={graphData}
          events={events}
          className="team-graph-view size-full"
          suspendAnimation={!isActive}
          onRequestFullscreen={() => setFullscreen(true)}
          onOpenTeamPage={openTeamPage}
          onCreateTask={openCreateTask}
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
                enabled={isActive}
                onOpenTaskDetail={dispatchOpenTask}
                onOpenMemberProfile={dispatchOpenProfile}
              />
              <GraphProvisioningHud
                teamName={teamName}
                leadNodeId={leadNodeId}
                getLaunchAnchorScreenPlacement={getLaunchAnchorScreenPlacement}
                enabled={isActive}
              />
            </>
          )}
          renderEdgeOverlay={({ edge, sourceNode, targetNode, onClose, onSelectNode }) => (
            <GraphBlockingEdgePopover
              teamName={teamName}
              edge={edge}
              sourceNode={sourceNode}
              targetNode={targetNode}
              onClose={onClose}
              onSelectNode={onSelectNode}
              onOpenTaskDetail={dispatchOpenTask}
            />
          )}
          renderOverlay={({ node, onClose }) => (
            <GraphNodePopover
              node={node}
              teamName={teamName}
              onClose={onClose}
              onSendMessage={dispatchSendMessage}
              onOpenTaskDetail={dispatchOpenTask}
              onOpenMemberProfile={dispatchOpenProfile}
              onCreateTask={openCreateTaskDialog}
              onStartTask={dispatchStartTask}
              onCompleteTask={dispatchCompleteTask}
              onApproveTask={dispatchApproveTask}
              onRequestReview={dispatchRequestReview}
              onRequestChanges={dispatchRequestChanges}
              onCancelTask={dispatchCancelTask}
              onMoveBackToDone={dispatchMoveBackToDone}
              onDeleteTask={dispatchDeleteTask}
            />
          )}
        />
      </div>
      {createTaskDialog}
      {fullscreen && (
        <Suspense fallback={null}>
          <TeamGraphOverlay
            teamName={teamName}
            onClose={() => setFullscreen(false)}
            onSendMessage={dispatchSendMessage}
            onOpenTaskDetail={dispatchOpenTask}
            onOpenMemberProfile={dispatchOpenProfile}
          />
        </Suspense>
      )}
    </div>
  );
};
