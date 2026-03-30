/**
 * TeamGraphTab — wraps GraphView for use as a dedicated tab.
 * Provides Fullscreen button that opens the overlay.
 */

import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { TeamSidebarHost } from '@renderer/components/team/sidebar/TeamSidebarHost';

import { useTeamGraphAdapter } from '../adapters/useTeamGraphAdapter';

import { GraphNodePopover } from './GraphNodePopover';

import type { GraphDomainRef, GraphEventPort, GraphNode } from '@claude-teams/agent-graph';

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
  const graphData = useTeamGraphAdapter(teamName);
  const [fullscreen, setFullscreen] = useState(false);

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
    (memberName: string) =>
      window.dispatchEvent(
        new CustomEvent('graph:open-profile', { detail: { teamName, memberName } })
      ),
    [teamName]
  );
  const dispatchCreateTask = useCallback(
    (owner: string) =>
      window.dispatchEvent(new CustomEvent('graph:create-task', { detail: { teamName, owner } })),
    [teamName]
  );

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
    onOpenMemberProfile: dispatchOpenProfile,
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
          className="size-full"
          suspendAnimation={!isActive}
          onRequestFullscreen={() => setFullscreen(true)}
          renderOverlay={({ node, onClose }) => (
            <GraphNodePopover
              node={node}
              teamName={teamName}
              onClose={onClose}
              onSendMessage={dispatchSendMessage}
              onOpenTaskDetail={dispatchOpenTask}
              onOpenMemberProfile={dispatchOpenProfile}
              onCreateTask={dispatchCreateTask}
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
