import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ActivityItem } from '@renderer/components/team/activity/ActivityItem';
import {
  buildMessageContext,
  resolveMessageRenderProps,
} from '@renderer/components/team/activity/activityMessageContext';
import { MessageExpandDialog } from '@renderer/components/team/activity/MessageExpandDialog';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { useStableTeamMentionMeta } from '@renderer/hooks/useStableTeamMentionMeta';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { useShallow } from 'zustand/react/shallow';

import {
  buildInlineActivityEntries,
  getGraphLeadMemberName,
  type InlineActivityEntry,
} from '../utils/buildInlineActivityEntries';

import type { TimelineItem } from '@renderer/components/team/activity/LeadThoughtsGroup';
import type { GraphNode } from '@claude-teams/agent-graph';
import type { ResolvedTeamMember } from '@shared/types/team';

interface GraphActivityHudProps {
  teamName: string;
  nodes: GraphNode[];
  getActivityAnchorScreenPlacement: (
    ownerNodeId: string
  ) => { x: number; y: number; scale: number; visible: boolean } | null;
  focusNodeIds: ReadonlySet<string> | null;
  enabled?: boolean;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenMemberProfile?: (memberName: string) => void;
}

export function GraphActivityHud({
  teamName,
  nodes,
  getActivityAnchorScreenPlacement,
  focusNodeIds,
  enabled = true,
  onOpenTaskDetail,
  onOpenMemberProfile,
}: GraphActivityHudProps): React.JSX.Element | null {
  const shellRefs = useRef(new Map<string, HTMLDivElement | null>());
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
      return;
    }

    let frameId = 0;
    const updatePositions = (): void => {
      for (const lane of visibleLanes) {
        const shell = shellRefs.current.get(lane.node.id);
        if (!shell) {
          continue;
        }

        const placement = getActivityAnchorScreenPlacement(lane.node.id);
        if (!placement || !placement.visible) {
          shell.style.opacity = '0';
          continue;
        }

        const baseOpacity = focusNodeIds && !focusNodeIds.has(lane.node.id) ? 0.25 : 1;
        shell.style.opacity = String(baseOpacity);
        shell.style.transform = `translate(${Math.round(placement.x)}px, ${Math.round(placement.y)}px) scale(${placement.scale.toFixed(3)})`;
      }

      frameId = window.requestAnimationFrame(updatePositions);
    };

    updatePositions();
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [enabled, focusNodeIds, getActivityAnchorScreenPlacement, visibleLanes]);

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

  if (!enabled || !teamData || visibleLanes.length === 0) {
    return null;
  }

  return (
    <>
      {visibleLanes.map((lane) => (
        <div
          key={lane.node.id}
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
              <div className="rounded-md border border-white/10 bg-[rgba(8,14,28,0.64)] px-3 py-1 text-center text-[11px] font-medium text-slate-300">
                +{lane.overflowCount} more
              </div>
            ) : null}
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
}
