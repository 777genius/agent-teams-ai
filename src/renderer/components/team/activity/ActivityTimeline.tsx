import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { toMessageKey } from '@renderer/utils/teamMessageKey';

import { ActivityItem, isNoiseMessage } from './ActivityItem';
import { AnimatedHeightReveal } from './AnimatedHeightReveal';
import { findNewestMessageIndex, resolveTimelineCollapseState } from './collapseState';
import {
  getThoughtGroupKey,
  groupTimelineItems,
  isLeadThought,
  LeadThoughtsGroupRow,
} from './LeadThoughtsGroup';
import { useNewItemKeys } from './useNewItemKeys';

import type { ActivityCollapseState } from './collapseState';
import type { TimelineItem } from './LeadThoughtsGroup';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

interface ActivityTimelineProps {
  messages: InboxMessage[];
  teamName: string;
  members?: ResolvedTeamMember[];
  /**
   * When provided, unread is derived from this set and getMessageKey.
   * When omitted, unread is derived from message.read.
   */
  readState?: { readSet: Set<string>; getMessageKey: (message: InboxMessage) => string };
  onCreateTaskFromMessage?: (subject: string, description: string) => void;
  onReplyToMessage?: (message: InboxMessage) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  /** Called when a message enters the viewport (for marking as read). */
  onMessageVisible?: (message: InboxMessage) => void;
  /** Called when a task ID link (e.g. #10) is clicked in message text. */
  onTaskIdClick?: (taskId: string) => void;
  /** Called when the user clicks "Restart team" on an auth error message. */
  onRestartTeam?: () => void;
  /** When true, collapse all message bodies — show only headers with expand chevrons. */
  allCollapsed?: boolean;
  /** Set of stable message keys that the user has manually expanded in collapsed mode. */
  expandOverrides?: Set<string>;
  /** Called when user toggles expand/collapse override on a specific message. */
  onToggleExpandOverride?: (key: string) => void;
  /**
   * All session IDs belonging to this team (current + history).
   * Used together with currentLeadSessionId to suppress only the reconnect boundary
   * from the current live session back into the team's previous session history.
   */
  teamSessionIds?: Set<string>;
  /** Current lead session ID for the active team, if known. */
  currentLeadSessionId?: string;
}

const VIEWPORT_THRESHOLD = 0.15;
const MESSAGES_PAGE_SIZE = 30;

const MessageRowWithObserver = ({
  message,
  teamName,
  memberRole,
  memberColor,
  recipientColor,
  isUnread,
  isNew,
  zebraShade,
  memberColorMap,
  onMemberNameClick,
  onCreateTask,
  onReply,
  onVisible,
  onTaskIdClick,
  onRestartTeam,
  collapseState,
}: {
  message: InboxMessage;
  teamName: string;
  memberRole?: string;
  memberColor?: string;
  recipientColor?: string;
  isUnread?: boolean;
  isNew?: boolean;
  zebraShade?: boolean;
  memberColorMap?: Map<string, string>;
  onMemberNameClick?: (name: string) => void;
  onCreateTask?: (subject: string, description: string) => void;
  onReply?: (message: InboxMessage) => void;
  onVisible?: (message: InboxMessage) => void;
  onTaskIdClick?: (taskId: string) => void;
  onRestartTeam?: () => void;
  collapseState?: ActivityCollapseState;
}): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  const reportedRef = useRef(false);
  const messageRef = useRef(message);
  const onVisibleRef = useRef(onVisible);

  useEffect(() => {
    messageRef.current = message;
    onVisibleRef.current = onVisible;
  }, [message, onVisible]);

  useEffect(() => {
    if (!onVisible) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        if (reportedRef.current) return;
        const cb = onVisibleRef.current;
        const msg = messageRef.current;
        if (!cb) return;
        reportedRef.current = true;
        cb(msg);
      },
      { threshold: VIEWPORT_THRESHOLD, rootMargin: '0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [onVisible]);

  return (
    <AnimatedHeightReveal animate={isNew} containerRef={ref}>
      <ActivityItem
        message={message}
        teamName={teamName}
        memberRole={memberRole}
        memberColor={memberColor}
        recipientColor={recipientColor}
        isUnread={isUnread}
        zebraShade={zebraShade}
        memberColorMap={memberColorMap}
        onMemberNameClick={onMemberNameClick}
        onCreateTask={onCreateTask}
        onReply={onReply}
        onTaskIdClick={onTaskIdClick}
        onRestartTeam={onRestartTeam}
        collapseState={collapseState}
      />
    </AnimatedHeightReveal>
  );
};

export const ActivityTimeline = ({
  messages,
  teamName,
  members,
  readState,
  onCreateTaskFromMessage,
  onReplyToMessage,
  onMemberClick,
  onMessageVisible,
  onTaskIdClick,
  onRestartTeam,
  allCollapsed,
  expandOverrides,
  onToggleExpandOverride,
  teamSessionIds,
  currentLeadSessionId,
}: ActivityTimelineProps): React.JSX.Element => {
  const [visibleCount, setVisibleCount] = useState(MESSAGES_PAGE_SIZE);

  const colorMap = members ? buildMemberColorMap(members) : new Map<string, string>();
  const memberInfo = new Map<string, { role?: string; color?: string }>();
  if (members) {
    for (const m of members) {
      const info = {
        role: m.role ?? (m.agentType !== 'general-purpose' ? m.agentType : undefined),
        color: colorMap.get(m.name),
      };
      memberInfo.set(m.name, info);
      if (m.agentType && m.agentType !== m.name) {
        memberInfo.set(m.agentType, info);
      }
    }
    // Map "user" to team-lead's resolved color and role
    const leadMember = members.find(
      (m) => m.agentType === 'team-lead' || m.role?.toLowerCase().includes('lead')
    );
    if (leadMember) {
      const leadInfo = memberInfo.get(leadMember.name);
      if (leadInfo) {
        memberInfo.set('user', { role: undefined, color: colorMap.get('user') });
      }
    }
  }

  const handleMemberNameClick = (name: string): void => {
    const member = members?.find((m) => m.name === name || m.agentType === name);
    if (member) onMemberClick?.(member);
  };

  // Pagination counts only significant (non-thought) messages so that lead thoughts
  // don't consume the page limit — they collapse into a single visual group anyway.
  const { visibleMessages, hiddenCount } = useMemo(() => {
    const total = messages.length;
    if (total === 0) return { visibleMessages: messages, hiddenCount: 0 };

    let significantSeen = 0;
    let cutoff = total;
    for (let i = 0; i < total; i++) {
      if (!isLeadThought(messages[i])) {
        significantSeen++;
        if (significantSeen > visibleCount) {
          cutoff = i;
          break;
        }
      }
    }

    const significantTotal =
      significantSeen +
      (cutoff < total ? messages.slice(cutoff).filter((m) => !isLeadThought(m)).length : 0);
    const hidden = Math.max(0, significantTotal - visibleCount);
    return {
      visibleMessages: cutoff < total ? messages.slice(0, cutoff) : messages,
      hiddenCount: hidden,
    };
  }, [messages, visibleCount]);

  // Group consecutive lead thoughts into collapsible blocks.
  const timelineItems = useMemo(() => groupTimelineItems(visibleMessages), [visibleMessages]);

  // Zebra striping is anchored from the bottom of the visible list so prepending
  // new live messages at the top does not recolor every existing card.
  const zebraShadeSet = useMemo(() => {
    const result = new Set<number>();
    let cardCount = 0;
    for (let i = timelineItems.length - 1; i >= 0; i--) {
      const item = timelineItems[i];
      if (item.type === 'lead-thoughts') {
        // Thought groups count as one card for striping
        if (cardCount % 2 === 1) result.add(i);
        cardCount++;
      } else {
        if (isNoiseMessage(item.message.text)) continue;
        if (cardCount % 2 === 1) result.add(i);
        cardCount++;
      }
    }
    return result;
  }, [timelineItems]);

  const timelineItemKeys = useMemo(() => {
    const getItemKey = (item: TimelineItem): string => {
      if (item.type === 'lead-thoughts') {
        return getThoughtGroupKey(item.group);
      }
      return toMessageKey(item.message);
    };

    return timelineItems.map(getItemKey);
  }, [timelineItems]);

  const newItemKeys = useNewItemKeys({
    itemKeys: timelineItemKeys,
    paginationKey: visibleCount,
    resetKey: teamName,
  });

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const key of timelineItemKeys) {
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    if (duplicates.size > 0) {
      console.warn('[ActivityTimeline] Duplicate timeline item keys detected', {
        teamName,
        duplicates: [...duplicates],
      });
    }
  }, [teamName, timelineItemKeys]);

  const handleShowMore = (): void => {
    setVisibleCount((prev) => prev + MESSAGES_PAGE_SIZE);
  };

  const handleShowAll = (): void => {
    setVisibleCount(Infinity);
  };

  const getItemSessionId = (item: TimelineItem): string | undefined =>
    item.type === 'lead-thoughts'
      ? item.group.thoughts[0].leadSessionId
      : item.message.leadSessionId;

  // Pin the newest thought group (if first) so it stays at the top and doesn't jump.
  const pinnedThoughtGroup = timelineItems[0]?.type === 'lead-thoughts' ? timelineItems[0] : null;
  const startIndex = pinnedThoughtGroup ? 1 : 0;

  // Determine the index of the "newest" non-thought timeline item (for auto-expand).
  const newestMessageIndex = useMemo(() => {
    return findNewestMessageIndex(timelineItems);
  }, [timelineItems]);

  /**
   * Compute the externally managed collapse state for an item in the timeline.
   * In collapsed mode we always keep the newest real message open, keep the pinned
   * thought group open, and let localStorage overrides reopen older items.
   */
  const getItemCollapseState = useCallback(
    (stableKey: string, itemIndex: number): ActivityCollapseState =>
      resolveTimelineCollapseState({
        allCollapsed,
        itemIndex,
        newestMessageIndex,
        isPinnedThoughtGroup: itemIndex === 0 && pinnedThoughtGroup != null,
        isExpandedOverride: expandOverrides?.has(stableKey) ?? false,
        onToggleOverride: onToggleExpandOverride
          ? () => onToggleExpandOverride(stableKey)
          : undefined,
      }),
    [allCollapsed, newestMessageIndex, pinnedThoughtGroup, expandOverrides, onToggleExpandOverride]
  );

  if (messages.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
        <p>No messages</p>
        <p className="mt-1 text-[11px]">Send a message to a member to see activity.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* Pinned (newest) thought group — always at top */}
      {pinnedThoughtGroup &&
        (() => {
          const { group } = pinnedThoughtGroup;
          const firstThought = group.thoughts[0];
          const info = memberInfo.get(firstThought.from);
          const itemKey = getThoughtGroupKey(group);
          const stableKey = itemKey;
          const collapseState = getItemCollapseState(stableKey, 0);
          return (
            <LeadThoughtsGroupRow
              key={itemKey}
              group={group}
              memberColor={info?.color}
              canBeLive={true}
              isNew={newItemKeys.has(itemKey)}
              onVisible={onMessageVisible}
              zebraShade={zebraShadeSet.has(0)}
              collapseState={collapseState}
              onTaskIdClick={onTaskIdClick}
              memberColorMap={colorMap}
              onReply={onReplyToMessage}
            />
          );
        })()}

      {/* Remaining items */}
      {timelineItems.slice(startIndex).map((item, index) => {
        const realIndex = index + startIndex;

        // Session boundary separator (messages sorted desc — new on top)
        let sessionSeparator: React.JSX.Element | null = null;
        if (realIndex > 0) {
          const prevSessionId = getItemSessionId(timelineItems[realIndex - 1]);
          const currSessionId = getItemSessionId(item);
          if (prevSessionId && currSessionId && prevSessionId !== currSessionId) {
            // Suppress only the boundary between the current live session and the team's
            // older session history. Older historical session boundaries should still render.
            const isReconnectBoundary =
              !!currentLeadSessionId &&
              teamSessionIds &&
              teamSessionIds.has(prevSessionId) &&
              teamSessionIds.has(currSessionId) &&
              (prevSessionId === currentLeadSessionId || currSessionId === currentLeadSessionId);
            if (!isReconnectBoundary) {
              sessionSeparator = (
                <div
                  className="flex items-center gap-3"
                  style={{ paddingTop: 45, paddingBottom: 45 }}
                >
                  <div className="h-px flex-1 bg-blue-600/30 dark:bg-blue-400/30" />
                  <span className="whitespace-nowrap text-[11px] font-medium text-blue-600 dark:text-blue-400">
                    New session
                  </span>
                  <div className="h-px flex-1 bg-blue-600/30 dark:bg-blue-400/30" />
                </div>
              );
            }
          }
        }

        if (item.type === 'lead-thoughts') {
          const { group } = item;
          const firstThought = group.thoughts[0];
          const info = memberInfo.get(firstThought.from);
          const itemKey = getThoughtGroupKey(group);
          const stableKey = itemKey;
          const collapseState = getItemCollapseState(stableKey, realIndex);
          return (
            <React.Fragment key={itemKey}>
              {sessionSeparator}
              <LeadThoughtsGroupRow
                group={group}
                memberColor={info?.color}
                canBeLive={false}
                isNew={newItemKeys.has(itemKey)}
                onVisible={onMessageVisible}
                zebraShade={zebraShadeSet.has(realIndex)}
                collapseState={collapseState}
                onTaskIdClick={onTaskIdClick}
                memberColorMap={colorMap}
                onReply={onReplyToMessage}
              />
            </React.Fragment>
          );
        }

        const { message } = item;
        const info = memberInfo.get(message.from);
        const recipientInfo = message.to ? memberInfo.get(message.to) : undefined;
        const recipientColor =
          recipientInfo?.color ?? (message.to ? colorMap.get(message.to) : undefined);
        const messageKey = toMessageKey(message);
        const stableKey = messageKey;
        const collapseState = getItemCollapseState(stableKey, realIndex);
        const isUnread = readState
          ? !message.read && !readState.readSet.has(readState.getMessageKey(message))
          : !message.read;
        return (
          <React.Fragment key={messageKey}>
            {sessionSeparator}
            <MessageRowWithObserver
              message={message}
              teamName={teamName}
              memberRole={info?.role}
              memberColor={info?.color}
              recipientColor={recipientColor}
              isUnread={isUnread}
              isNew={newItemKeys.has(messageKey)}
              zebraShade={zebraShadeSet.has(realIndex)}
              memberColorMap={colorMap}
              onMemberNameClick={onMemberClick ? handleMemberNameClick : undefined}
              onCreateTask={onCreateTaskFromMessage}
              onReply={onReplyToMessage}
              onVisible={onMessageVisible}
              onTaskIdClick={onTaskIdClick}
              onRestartTeam={onRestartTeam}
              collapseState={collapseState}
            />
          </React.Fragment>
        );
      })}
      {hiddenCount > 0 && (
        <div className="relative flex justify-center pb-3 pt-1">
          {/* Bottom-up shadow gradient: darkest at bottom edge, fades upward */}
          <div
            className="pointer-events-none absolute inset-x-0 -top-24"
            style={{
              bottom: '-1.6rem',
              background:
                'linear-gradient(to top, rgba(0, 0, 0, 0.4) 0%, rgba(0, 0, 0, 0.25) 25%, rgba(0, 0, 0, 0.1) 50%, rgba(0, 0, 0, 0.03) 75%, transparent 100%)',
            }}
          />
          <div
            className="relative z-[1] flex items-center gap-3 rounded-full px-4 py-1.5"
            style={{
              backgroundColor: 'var(--color-surface-raised)',
              boxShadow:
                '0 0 12px 4px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
              border: '1px solid var(--color-border-emphasis)',
            }}
          >
            <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
              +{hiddenCount} older
            </span>
            <span className="h-3 w-px bg-blue-600/30 dark:bg-blue-400/30" />
            <button
              onClick={handleShowMore}
              className="rounded-full px-2.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-all hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-text)]"
            >
              Show {Math.min(MESSAGES_PAGE_SIZE, hiddenCount)} more
            </button>
            {hiddenCount > MESSAGES_PAGE_SIZE && (
              <>
                <span className="h-3 w-px bg-blue-600/30 dark:bg-blue-400/30" />
                <button
                  onClick={handleShowAll}
                  className="rounded-full px-2.5 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-all hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-text-secondary)]"
                >
                  Show all
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
