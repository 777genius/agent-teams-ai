/**
 * TeamGraphTab — wraps GraphView for use as a dedicated tab.
 * Provides Fullscreen button that opens the overlay.
 */

import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import { GraphView } from '@claude-teams/agent-graph';
import { TeamSidebarHost } from '@renderer/components/team/sidebar/TeamSidebarHost';

import { useGraphCreateTaskDialog } from '../hooks/useGraphCreateTaskDialog';
import { useGraphSidebarVisibility } from '../hooks/useGraphSidebarVisibility';
import { useTeamGraphAdapter } from '../hooks/useTeamGraphAdapter';
import { useTeamGraphSurfaceActions } from '../hooks/useTeamGraphSurfaceActions';

import { GraphActivityHud } from './GraphActivityHud';
import { GraphBlockingEdgePopover } from './GraphBlockingEdgePopover';
import { GraphNodePopover } from './GraphNodePopover';
import { GraphProvisioningHud } from './GraphProvisioningHud';
import { GraphTransientHandoffHud } from './GraphTransientHandoffHud';

import type { GraphDomainRef, GraphEventPort } from '@claude-teams/agent-graph';
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
  const { openTeamPage, commitOwnerSlotDrop, commitOwnerGridOrderDrop, setLayoutMode } =
    useTeamGraphSurfaceActions(teamName);
  const [fullscreen, setFullscreen] = useState(false);
  const { sidebarVisible, toggleSidebarVisible } = useGraphSidebarVisibility();
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
      {sidebarVisible ? (
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
          onToggleSidebar={toggleSidebarVisible}
          isSidebarVisible={sidebarVisible}
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
              getCameraZoom?: () => number;
              getTransientHandoffSnapshot?: (options?: {
                focusNodeIds?: ReadonlySet<string> | null;
                focusEdgeIds?: ReadonlySet<string> | null;
              }) => {
                cards: import('@claude-teams/agent-graph').TransientHandoffCard[];
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
                  onOpenTaskDetail={dispatchOpenTask}
                  onOpenMemberProfile={dispatchOpenProfile}
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
            sidebarVisible={sidebarVisible}
            onToggleSidebar={toggleSidebarVisible}
            onSendMessage={dispatchSendMessage}
            onOpenTaskDetail={dispatchOpenTask}
            onOpenMemberProfile={dispatchOpenProfile}
          />
        </Suspense>
      )}
    </div>
  );
};
