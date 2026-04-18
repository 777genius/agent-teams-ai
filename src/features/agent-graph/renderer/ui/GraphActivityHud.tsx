import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ACTIVITY_LANE } from '@claude-teams/agent-graph';
import { buildMessageContext } from '@renderer/components/team/activity/activityMessageContext';
import { MessageExpandDialog } from '@renderer/components/team/activity/MessageExpandDialog';
import { useStableTeamMentionMeta } from '@renderer/hooks/useStableTeamMentionMeta';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { toMessageKey } from '@renderer/utils/teamMessageKey';

import {
  buildInlineActivityEntries,
  getGraphLeadMemberName,
  type InlineActivityEntry,
} from '../../core/domain/buildInlineActivityEntries';
import { useGraphActivityContext } from '../hooks/useGraphActivityContext';

import { GraphActivityCard } from './GraphActivityCard';

import type { GraphNode } from '@claude-teams/agent-graph';
import type { TimelineItem } from '@renderer/components/team/activity/LeadThoughtsGroup';
import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';
import type { ResolvedTeamMember } from '@shared/types/team';

const ACTIVITY_SHELL_HEIGHT =
  ACTIVITY_LANE.headerHeight +
  ACTIVITY_LANE.maxVisibleItems * ACTIVITY_LANE.rowHeight +
  ACTIVITY_LANE.overflowHeight;

interface GraphActivityHudProps {
  teamName: string;
  nodes: GraphNode[];
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
  getViewportSize?: () => { width: number; height: number };
  focusNodeIds: ReadonlySet<string> | null;
  enabled?: boolean;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenMemberProfile?: (
    memberName: string,
    options?: {
      initialTab?: MemberDetailTab;
      initialActivityFilter?: MemberActivityFilter;
    }
  ) => void;
}

export const GraphActivityHud = ({
  teamName,
  nodes,
  getActivityWorldRect = () => null,
  getCameraZoom = () => 1,
  worldToScreen,
  getNodeWorldPosition = () => null,
  getViewportSize,
  focusNodeIds,
  enabled = true,
  onOpenTaskDetail,
  onOpenMemberProfile,
}: GraphActivityHudProps): React.JSX.Element | null => {
  const worldLayerRef = useRef<HTMLDivElement | null>(null);
  const shellRefs = useRef(new Map<string, HTMLDivElement | null>());
  const connectorRefs = useRef(new Map<string, SVGSVGElement | null>());
  const connectorPathRefs = useRef(new Map<string, SVGPathElement | null>());
  const [expandedItem, setExpandedItem] = useState<TimelineItem | null>(null);
  const { teamData, teams } = useGraphActivityContext(teamName);
  const teamSnapshot = teamData;
  const members = teamData?.members ?? [];
  const messages = teamData?.messageFeed ?? [];

  const ownerNodes = useMemo(
    () =>
      nodes.filter(
        (node): node is GraphNode & { kind: 'lead' | 'member' } =>
          node.kind === 'lead' || node.kind === 'member'
      ),
    [nodes]
  );
  const leadNodeId = ownerNodes.find((node) => node.kind === 'lead')?.id ?? `lead:${teamName}`;
  const leadName = teamSnapshot
    ? getGraphLeadMemberName({ members }, teamName)
    : `${teamName}-lead`;
  const ownerNodeIds = useMemo(() => new Set(ownerNodes.map((node) => node.id)), [ownerNodes]);
  const entryMapByOwnerNodeId = useMemo(() => {
    if (!teamSnapshot) {
      return new Map<string, InlineActivityEntry[]>();
    }
    return buildInlineActivityEntries({
      data: {
        members,
        tasks: teamSnapshot.tasks,
        messages,
      },
      teamName,
      leadId: leadNodeId,
      leadName,
      ownerNodeIds,
    });
  }, [leadName, leadNodeId, members, messages, ownerNodeIds, teamName, teamSnapshot]);
  const messageContext = useMemo(() => buildMessageContext(members), [members]);
  const { teamNames, teamColorByName } = useStableTeamMentionMeta(teams);
  const { readSet } = useTeamMessagesRead(teamName);

  useEffect(() => {
    setExpandedItem(null);
  }, [teamName]);

  const visibleLanes = useMemo(() => {
    return ownerNodes
      .map((node) => {
        const graphItems = node.activityItems ?? [];
        const overflowCount = node.activityOverflowCount ?? 0;
        const visibleCount = Math.max(0, graphItems.length - overflowCount);
        const visibleGraphItems = graphItems.slice(0, visibleCount);
        const entriesById = new Map(
          (entryMapByOwnerNodeId.get(node.id) ?? []).map(
            (entry) => [entry.graphItem.id, entry] as const
          )
        );
        const entries = visibleGraphItems
          .map((item) => entriesById.get(item.id))
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

        return {
          node,
          entries,
          overflowCount,
        };
      })
      .filter(
        (lane) => lane.node.kind === 'member' || lane.entries.length > 0 || lane.overflowCount > 0
      );
  }, [entryMapByOwnerNodeId, ownerNodes]);

  useLayoutEffect(() => {
    if (!enabled || visibleLanes.length === 0) {
      for (const shell of shellRefs.current.values()) {
        if (shell) {
          shell.style.opacity = '0';
        }
      }
      for (const connector of connectorRefs.current.values()) {
        if (connector) {
          connector.style.opacity = '0';
        }
      }
      return;
    }

    let frameId = 0;
    const updatePositions = (): void => {
      const worldLayer = worldLayerRef.current;
      if (worldLayer && worldToScreen) {
        const origin = worldToScreen(0, 0);
        const zoom = Math.max(getCameraZoom(), 0.001);
        worldLayer.style.transform = `translate(${Math.round(origin.x)}px, ${Math.round(origin.y)}px) scale(${zoom.toFixed(3)})`;
      }

      const measurableLanes: {
        lane: (typeof visibleLanes)[number];
        shell: HTMLDivElement;
        connector: SVGSVGElement | null;
        connectorPath: SVGPathElement | null;
        laneRect: NonNullable<ReturnType<typeof getActivityWorldRect>>;
        nodeWorld: { x: number; y: number };
      }[] = [];

      for (const lane of visibleLanes) {
        const shell = shellRefs.current.get(lane.node.id);
        if (!shell) {
          continue;
        }
        const connector = connectorRefs.current.get(lane.node.id) ?? null;
        const connectorPath = connectorPathRefs.current.get(lane.node.id) ?? null;

        const laneRect = getActivityWorldRect(lane.node.id);
        const nodeWorld = getNodeWorldPosition(lane.node.id);
        if (!laneRect || !nodeWorld || !worldToScreen) {
          shell.style.opacity = '0';
          if (connector) {
            connector.style.opacity = '0';
          }
          continue;
        }

        const zoom = Math.max(getCameraZoom(), 0.001);
        const screenTopLeft = worldToScreen(laneRect.left, laneRect.top);
        const widthScreen = Math.max(1, laneRect.width * zoom);
        const heightScreen = Math.max(1, laneRect.height * zoom);
        const viewport = getViewportSize?.();
        const laneVisible =
          !viewport ||
          (screenTopLeft.x + widthScreen > -80 &&
            screenTopLeft.x < viewport.width + 80 &&
            screenTopLeft.y + heightScreen > -80 &&
            screenTopLeft.y < viewport.height + 80);
        if (!laneVisible) {
          shell.style.opacity = '0';
          if (connector) {
            connector.style.opacity = '0';
          }
          continue;
        }

        measurableLanes.push({
          lane,
          shell,
          connector,
          connectorPath,
          laneRect,
          nodeWorld,
        });
      }

      for (const entry of measurableLanes) {
        const { lane, shell, connector, connectorPath, laneRect, nodeWorld } = entry;
        const baseOpacity = focusNodeIds && !focusNodeIds.has(lane.node.id) ? 0.25 : 1;

        shell.style.opacity = String(baseOpacity);
        shell.style.left = `${Math.round(laneRect.left)}px`;
        shell.style.top = `${Math.round(laneRect.top)}px`;
        shell.style.transform = '';

        if (connector && connectorPath) {
          const endX = laneRect.left + laneRect.width / 2;
          const endY = laneRect.top >= nodeWorld.y ? laneRect.top + 10 : laneRect.bottom - 10;
          const startX = nodeWorld.x;
          const startY = nodeWorld.y - 18;
          const minX = Math.min(startX, endX);
          const minY = Math.min(startY, endY);
          const connectorWidth = Math.max(1, Math.abs(endX - startX));
          const connectorHeight = Math.max(1, Math.abs(endY - startY));
          const localStartX = startX - minX;
          const localStartY = startY - minY;
          const localEndX = endX - minX;
          const localEndY = endY - minY;
          const dx = localEndX - localStartX;
          const curve = Math.max(28, Math.abs(dx) * 0.35);
          const c1x = localStartX + Math.sign(dx || 1) * curve;
          const c1y = localStartY;
          const c2x = localEndX - Math.sign(dx || 1) * curve;
          const c2y = localEndY;

          connector.style.opacity = String(baseOpacity);
          connector.style.left = `${Math.round(minX)}px`;
          connector.style.top = `${Math.round(minY)}px`;
          connector.setAttribute('width', String(Math.ceil(connectorWidth)));
          connector.setAttribute('height', String(Math.ceil(connectorHeight)));
          connector.setAttribute(
            'viewBox',
            `0 0 ${Math.ceil(connectorWidth)} ${Math.ceil(connectorHeight)}`
          );
          connectorPath.setAttribute(
            'd',
            `M ${localStartX.toFixed(1)} ${localStartY.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${localEndX.toFixed(1)} ${localEndY.toFixed(1)}`
          );
        }
      }

      frameId = window.requestAnimationFrame(updatePositions);
    };

    updatePositions();
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    enabled,
    focusNodeIds,
    getActivityWorldRect,
    getCameraZoom,
    getNodeWorldPosition,
    getViewportSize,
    worldToScreen,
    visibleLanes,
  ]);

  const handleMessageClick = useCallback((item: TimelineItem) => {
    setExpandedItem(item);
  }, []);

  const handleMemberClick = useCallback(
    (member: ResolvedTeamMember) => {
      onOpenMemberProfile?.(member.name);
    },
    [onOpenMemberProfile]
  );

  const handleOpenOwnerActivity = useCallback(
    (node: GraphNode & { kind: 'lead' | 'member' }) => {
      if (node.domainRef.kind !== 'lead' && node.domainRef.kind !== 'member') {
        return;
      }
      onOpenMemberProfile?.(node.domainRef.memberName, {
        initialTab: 'activity',
        initialActivityFilter: 'all',
      });
    },
    [onOpenMemberProfile]
  );

  const forwardWheelToGraph = useCallback((event: WheelEvent, shell: HTMLDivElement) => {
    const graphRoot = shell.closest('.team-graph-view');
    const canvas = graphRoot?.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      return;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        bubbles: true,
        cancelable: true,
      })
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const listeners: { shell: HTMLDivElement; handler: (event: WheelEvent) => void }[] = [];

    for (const lane of visibleLanes) {
      const shell = shellRefs.current.get(lane.node.id);
      if (!shell) {
        continue;
      }
      const handler = (event: WheelEvent): void => forwardWheelToGraph(event, shell);
      shell.addEventListener('wheel', handler, { passive: false });
      listeners.push({ shell, handler });
    }

    return () => {
      for (const { shell, handler } of listeners) {
        shell.removeEventListener('wheel', handler);
      }
    };
  }, [enabled, forwardWheelToGraph, visibleLanes]);

  if (!enabled || !teamSnapshot || visibleLanes.length === 0) {
    return null;
  }

  return (
    <>
      <div
        ref={worldLayerRef}
        className="pointer-events-none absolute left-0 top-0 z-[8] origin-top-left select-none"
      >
        {visibleLanes.map((lane) => (
          <div key={lane.node.id}>
            {(() => {
              const laneRect = getActivityWorldRect(lane.node.id);
              const laneWidth = laneRect?.width ?? ACTIVITY_LANE.width;
              const laneHeight = laneRect?.height ?? ACTIVITY_SHELL_HEIGHT;

              return (
                <>
                  <svg
                    ref={(element) => {
                      connectorRefs.current.set(lane.node.id, element);
                    }}
                    className="pointer-events-none absolute z-[9] overflow-visible opacity-0"
                  >
                    <path
                      ref={(element) => {
                        connectorPathRefs.current.set(lane.node.id, element);
                      }}
                      d=""
                      fill="none"
                      stroke="rgba(148, 163, 184, 0.3)"
                      strokeWidth="1.25"
                      strokeLinecap="round"
                      strokeDasharray="3 4"
                    />
                  </svg>
                  <div
                    ref={(element) => {
                      shellRefs.current.set(lane.node.id, element);
                    }}
                    className="pointer-events-auto absolute z-10 origin-top-left select-none opacity-0"
                    style={{
                      width: `${laneWidth}px`,
                      maxWidth: `${laneWidth}px`,
                      height: `${laneHeight}px`,
                    }}
                    onDragStart={(event) => {
                      event.preventDefault();
                    }}
                  >
                    <div className="flex h-full min-w-0 max-w-full flex-col overflow-hidden">
                      <div className="mb-1 px-1 text-[10px] font-semibold tracking-[0.2em] text-slate-400/70">
                        Activity
                      </div>
                      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
                        {lane.entries.length === 0 && lane.overflowCount === 0 ? (
                          <div className="flex h-[72px] min-h-[72px] items-center rounded-md border border-dashed border-white/10 bg-[rgba(8,14,28,0.28)] px-3 text-[11px] text-slate-400/60">
                            No recent activity
                          </div>
                        ) : null}
                        {lane.entries.map((entry, index) => {
                          const messageKey = toMessageKey(entry.message);
                          const timelineItem: TimelineItem = {
                            type: 'message',
                            message: entry.message,
                          };
                          const isUnread = !entry.message.read && !readSet.has(messageKey);

                          return (
                            <div
                              key={entry.graphItem.id}
                              className="h-[72px] min-h-[72px] min-w-0 max-w-full cursor-pointer overflow-hidden"
                              role="button"
                              tabIndex={0}
                              onClick={() => handleMessageClick(timelineItem)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  handleMessageClick(timelineItem);
                                }
                              }}
                            >
                              <GraphActivityCard
                                message={entry.message}
                                teamName={teamName}
                                messageContext={messageContext}
                                teamNames={teamNames}
                                teamColorByName={teamColorByName}
                                isUnread={isUnread}
                                zebraShade={index % 2 === 1}
                                onClick={() => handleMessageClick(timelineItem)}
                                onOpenTaskDetail={onOpenTaskDetail}
                                onOpenMemberProfile={onOpenMemberProfile}
                              />
                            </div>
                          );
                        })}

                        {lane.overflowCount > 0 ? (
                          <button
                            type="button"
                            className="h-8 min-h-8 w-full rounded-md border border-white/10 bg-[rgba(8,14,28,0.64)] px-3 py-1 text-center text-[11px] font-medium text-slate-300 transition-colors hover:border-white/20 hover:bg-[rgba(12,20,40,0.78)]"
                            onClick={() => handleOpenOwnerActivity(lane.node)}
                          >
                            +{lane.overflowCount} more
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        ))}
      </div>

      <MessageExpandDialog
        expandedItem={expandedItem}
        open={expandedItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExpandedItem(null);
          }
        }}
        teamName={teamName}
        members={members}
        onMemberClick={handleMemberClick}
        onTaskIdClick={onOpenTaskDetail}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
      />
    </>
  );
};
