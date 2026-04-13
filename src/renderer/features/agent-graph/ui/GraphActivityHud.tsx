import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ActivityItem } from '@renderer/components/team/activity/ActivityItem';
import {
  buildMessageContext,
  resolveMessageRenderProps,
} from '@renderer/components/team/activity/activityMessageContext';
import { MessageExpandDialog } from '@renderer/components/team/activity/MessageExpandDialog';
import { useStableTeamMentionMeta } from '@renderer/hooks/useStableTeamMentionMeta';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { useShallow } from 'zustand/react/shallow';

import {
  buildInlineActivityEntries,
  getGraphLeadMemberName,
  type InlineActivityEntry,
} from '../utils/buildInlineActivityEntries';

import type { GraphNode } from '@claude-teams/agent-graph';
import type { TimelineItem } from '@renderer/components/team/activity/LeadThoughtsGroup';
import type {
  MemberActivityFilter,
  MemberDetailTab,
} from '@renderer/components/team/members/memberDetailTypes';
import type { ResolvedTeamMember } from '@shared/types/team';

interface GraphActivityHudProps {
  teamName: string;
  nodes: GraphNode[];
  getActivityAnchorScreenPlacement: (
    ownerNodeId: string
  ) => { x: number; y: number; scale: number; visible: boolean } | null;
  getNodeScreenPosition?: (nodeId: string) => { x: number; y: number; visible: boolean } | null;
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
  getActivityAnchorScreenPlacement,
  getNodeScreenPosition = () => null,
  focusNodeIds,
  enabled = true,
  onOpenTaskDetail,
  onOpenMemberProfile,
}: GraphActivityHudProps): React.JSX.Element | null => {
  const shellRefs = useRef(new Map<string, HTMLDivElement | null>());
  const connectorRefs = useRef(new Map<string, SVGSVGElement | null>());
  const connectorPathRefs = useRef(new Map<string, SVGPathElement | null>());
  const [expandedItem, setExpandedItem] = useState<TimelineItem | null>(null);
  const { teamData, teams } = useStore(
    useShallow((state) => ({
      teamData: selectTeamDataForName(state, teamName),
      teams: state.teams,
    }))
  );

  const ownerNodes = useMemo(
    () =>
      nodes.filter(
        (node): node is GraphNode & { kind: 'lead' | 'member' } =>
          node.kind === 'lead' || node.kind === 'member'
      ),
    [nodes]
  );
  const leadNodeId = ownerNodes.find((node) => node.kind === 'lead')?.id ?? `lead:${teamName}`;
  const leadName = teamData ? getGraphLeadMemberName(teamData, teamName) : `${teamName}-lead`;
  const ownerNodeIds = useMemo(() => new Set(ownerNodes.map((node) => node.id)), [ownerNodes]);
  const entryMapByOwnerNodeId = useMemo(() => {
    if (!teamData) {
      return new Map<string, InlineActivityEntry[]>();
    }
    return buildInlineActivityEntries({
      data: teamData,
      teamName,
      leadId: leadNodeId,
      leadName,
      ownerNodeIds,
    });
  }, [leadName, leadNodeId, ownerNodeIds, teamData, teamName]);
  const messageContext = useMemo(() => buildMessageContext(teamData?.members), [teamData?.members]);
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
      .filter((lane) => lane.entries.length > 0 || lane.overflowCount > 0);
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
      for (const lane of visibleLanes) {
        const shell = shellRefs.current.get(lane.node.id);
        if (!shell) {
          continue;
        }
        const connector = connectorRefs.current.get(lane.node.id);
        const connectorPath = connectorPathRefs.current.get(lane.node.id) ?? null;

        const placement = getActivityAnchorScreenPlacement(lane.node.id);
        if (!placement?.visible) {
          shell.style.opacity = '0';
          if (connector) {
            connector.style.opacity = '0';
          }
          continue;
        }

        const baseOpacity = focusNodeIds && !focusNodeIds.has(lane.node.id) ? 0.25 : 1;
        shell.style.opacity = String(baseOpacity);
        shell.style.transform = `translate(${Math.round(placement.x)}px, ${Math.round(placement.y)}px) scale(${placement.scale.toFixed(3)})`;

        if (connector && connectorPath) {
          const nodeScreen = getNodeScreenPosition(lane.node.id);
          if (!nodeScreen?.visible) {
            connector.style.opacity = '0';
            continue;
          }
          const scaledWidth = (shell.offsetWidth || 296) * placement.scale;
          const laneCenterX = placement.x + scaledWidth / 2;
          const laneIsLeft = laneCenterX < nodeScreen.x;
          const endX = laneIsLeft ? placement.x + scaledWidth - 8 : placement.x + 8;
          const endY = placement.y + 10 * placement.scale;
          const startX = nodeScreen.x;
          const startY = nodeScreen.y - 10;
          const minX = Math.min(startX, endX);
          const minY = Math.min(startY, endY);
          const width = Math.max(1, Math.abs(endX - startX));
          const height = Math.max(1, Math.abs(endY - startY));
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
          connector.setAttribute('width', String(Math.ceil(width)));
          connector.setAttribute('height', String(Math.ceil(height)));
          connector.setAttribute('viewBox', `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
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
    getActivityAnchorScreenPlacement,
    getNodeScreenPosition,
    visibleLanes,
  ]);

  const expandedItemsByKey = useMemo(() => {
    const items = new Map<string, TimelineItem>();
    for (const lane of visibleLanes) {
      for (const entry of lane.entries) {
        const key = toMessageKey(entry.message);
        items.set(key, { type: 'message', message: entry.message });
      }
    }
    return items;
  }, [visibleLanes]);

  const handleExpandItem = useCallback(
    (key: string) => {
      const next = expandedItemsByKey.get(key);
      if (next) {
        setExpandedItem(next);
      }
    },
    [expandedItemsByKey]
  );

  const handleMessageClick = useCallback((item: TimelineItem) => {
    setExpandedItem(item);
  }, []);

  const handleMemberNameClick = useCallback(
    (memberName: string) => {
      onOpenMemberProfile?.(memberName);
    },
    [onOpenMemberProfile]
  );

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

  if (!enabled || !teamData || visibleLanes.length === 0) {
    return null;
  }

  return (
    <>
      {visibleLanes.map((lane) => (
        <div key={lane.node.id}>
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
            className="pointer-events-auto absolute z-10 w-[296px] origin-top-left opacity-0"
          >
            <div className="mb-1 px-1 text-[10px] font-semibold tracking-[0.2em] text-slate-400/70">
              Activity
            </div>
            <div className="space-y-2">
              {lane.entries.map((entry, index) => {
                const messageKey = toMessageKey(entry.message);
                const renderProps = resolveMessageRenderProps(entry.message, messageContext);
                const timelineItem: TimelineItem = { type: 'message', message: entry.message };
                const isUnread = !entry.message.read && !readSet.has(messageKey);

                return (
                  <div
                    key={entry.graphItem.id}
                    className="cursor-pointer"
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
                    <ActivityItem
                      message={entry.message}
                      teamName={teamName}
                      compactHeader
                      collapseMode="managed"
                      isCollapsed
                      canToggleCollapse={false}
                      isUnread={isUnread}
                      expandItemKey={messageKey}
                      onExpand={handleExpandItem}
                      memberRole={renderProps.memberRole}
                      memberColor={renderProps.memberColor}
                      recipientColor={renderProps.recipientColor}
                      memberColorMap={messageContext.colorMap}
                      localMemberNames={messageContext.localMemberNames}
                      onMemberNameClick={handleMemberNameClick}
                      onTaskIdClick={onOpenTaskDetail}
                      zebraShade={index % 2 === 1}
                      teamNames={teamNames}
                      teamColorByName={teamColorByName}
                    />
                  </div>
                );
              })}

              {lane.overflowCount > 0 ? (
                <button
                  type="button"
                  className="w-full rounded-md border border-white/10 bg-[rgba(8,14,28,0.64)] px-3 py-1 text-center text-[11px] font-medium text-slate-300 transition-colors hover:border-white/20 hover:bg-[rgba(12,20,40,0.78)]"
                  onClick={() => handleOpenOwnerActivity(lane.node)}
                >
                  +{lane.overflowCount} more
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ))}

      <MessageExpandDialog
        expandedItem={expandedItem}
        open={expandedItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setExpandedItem(null);
          }
        }}
        teamName={teamName}
        members={teamData.members}
        onMemberClick={handleMemberClick}
        onTaskIdClick={onOpenTaskDetail}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
      />
    </>
  );
};
