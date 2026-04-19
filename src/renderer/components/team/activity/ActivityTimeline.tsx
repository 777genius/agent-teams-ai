import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  areInboxMessagesEquivalentForRender,
  areStringArraysEqual,
  areStringMapsEqual,
} from '@renderer/utils/messageRenderEquality';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { Layers } from 'lucide-react';

import { ActivityItem, isNoiseMessage } from './ActivityItem';
import { buildMessageContext, resolveMessageRenderProps } from './activityMessageContext';
import { AnimatedHeightReveal } from './AnimatedHeightReveal';
import { findNewestMessageIndex, resolveTimelineCollapseState } from './collapseState';
import {
  getThoughtGroupKey,
  groupTimelineItems,
  isCompactionMessage,
  isLeadThought,
  LeadThoughtsGroupRow,
} from './LeadThoughtsGroup';
import { useNewItemKeys } from './useNewItemKeys';

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
  /** Current lead session ID for the active team, if known. */
  currentLeadSessionId?: string;
  /** Whether the current team is alive. */
  isTeamAlive?: boolean;
  /** Current lead activity status for the active team. */
  leadActivity?: string;
  /** Latest lead context timestamp for the active team. */
  leadContextUpdatedAt?: string;
  /** Team names used for mention/team-link rendering. */
  teamNames?: string[];
  /** Team color mapping used by markdown viewers. */
  teamColorByName?: ReadonlyMap<string, string>;
  /** Opens a team tab from cross-team badges or team:// links. */
  onTeamClick?: (teamName: string) => void;
  /** Callback to expand a message/thought item into a fullscreen dialog. */
  onExpandItem?: (key: string) => void;
  /** Called when ExpandableContent is expanded via "Show more" in any ActivityItem. */
  onExpandContent?: () => void;
}

const VIEWPORT_THRESHOLD = 0.15;
const MESSAGES_PAGE_SIZE = 30;
const COMPACT_MESSAGES_WIDTH_PX = 400;
const EMPTY_TEAM_NAMES: string[] = [];
const EMPTY_TEAM_COLOR_MAP = new Map<string, string>();
const DEFAULT_COLLAPSE_MODE = 'default' as const;

function getItemSessionAnchorId(item: TimelineItem): string | undefined {
  if (item.type === 'lead-thoughts') {
    return item.group.thoughts[0]?.leadSessionId;
  }
  return undefined;
}

interface ItemCollapseProps {
  collapseMode: 'default' | 'managed';
  isCollapsed: boolean;
  canToggleCollapse: boolean;
  collapseToggleKey?: string;
}

/** Inline compaction boundary divider — styled like session separators but with amber accent. */
const CompactionDivider = ({ message }: { message: InboxMessage }): React.JSX.Element => (
  <div className="flex items-center gap-3" style={{ paddingTop: 16, paddingBottom: 16 }}>
    <div
      className="h-px flex-1"
      style={{ backgroundColor: 'var(--tool-call-text)', opacity: 0.3 }}
    />
    <div className="flex shrink-0 items-center gap-2 px-3">
      <Layers size={12} style={{ color: 'var(--tool-call-text)' }} />
      <span
        className="whitespace-nowrap text-[11px] font-medium"
        style={{ color: 'var(--tool-call-text)' }}
      >
        {message.text}
      </span>
    </div>
    <div
      className="h-px flex-1"
      style={{ backgroundColor: 'var(--tool-call-text)', opacity: 0.3 }}
    />
  </div>
);

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
  localMemberNames,
  onMemberNameClick,
  onCreateTask,
  onReply,
  onVisible,
  onTaskIdClick,
  onRestartTeam,
  collapseMode,
  isCollapsed,
  canToggleCollapse,
  collapseToggleKey,
  onToggleCollapse,
  compactHeader,
  teamNames,
  teamColorByName,
  onTeamClick,
  onExpand,
  expandItemKey,
  onExpandContent,
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
  localMemberNames?: Set<string>;
  onMemberNameClick?: (name: string) => void;
  onCreateTask?: (subject: string, description: string) => void;
  onReply?: (message: InboxMessage) => void;
  onVisible?: (message: InboxMessage) => void;
  onTaskIdClick?: (taskId: string) => void;
  onRestartTeam?: () => void;
  collapseMode: 'default' | 'managed';
  isCollapsed: boolean;
  canToggleCollapse: boolean;
  collapseToggleKey?: string;
  onToggleCollapse?: (key: string) => void;
  compactHeader?: boolean;
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
  onExpand?: (key: string) => void;
  expandItemKey?: string;
  onExpandContent?: () => void;
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
        localMemberNames={localMemberNames}
        onMemberNameClick={onMemberNameClick}
        onCreateTask={onCreateTask}
        onReply={onReply}
        onTaskIdClick={onTaskIdClick}
        onRestartTeam={onRestartTeam}
        collapseMode={collapseMode}
        isCollapsed={isCollapsed}
        canToggleCollapse={canToggleCollapse}
        collapseToggleKey={collapseToggleKey}
        onToggleCollapse={onToggleCollapse}
        compactHeader={compactHeader}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
        onTeamClick={onTeamClick}
        onExpand={onExpand}
        expandItemKey={expandItemKey}
        onExpandContent={onExpandContent}
      />
    </AnimatedHeightReveal>
  );
};

const MemoizedMessageRowWithObserver = React.memo(
  MessageRowWithObserver,
  (prev, next) =>
    prev.teamName === next.teamName &&
    prev.memberRole === next.memberRole &&
    prev.memberColor === next.memberColor &&
    prev.recipientColor === next.recipientColor &&
    prev.isUnread === next.isUnread &&
    prev.isNew === next.isNew &&
    prev.zebraShade === next.zebraShade &&
    prev.memberColorMap === next.memberColorMap &&
    prev.localMemberNames === next.localMemberNames &&
    prev.onMemberNameClick === next.onMemberNameClick &&
    prev.onCreateTask === next.onCreateTask &&
    prev.onReply === next.onReply &&
    prev.onVisible === next.onVisible &&
    prev.onTaskIdClick === next.onTaskIdClick &&
    prev.onRestartTeam === next.onRestartTeam &&
    prev.collapseMode === next.collapseMode &&
    prev.isCollapsed === next.isCollapsed &&
    prev.canToggleCollapse === next.canToggleCollapse &&
    prev.collapseToggleKey === next.collapseToggleKey &&
    prev.onToggleCollapse === next.onToggleCollapse &&
    prev.compactHeader === next.compactHeader &&
    areStringArraysEqual(prev.teamNames, next.teamNames) &&
    areStringMapsEqual(prev.teamColorByName, next.teamColorByName) &&
    prev.onTeamClick === next.onTeamClick &&
    prev.onExpand === next.onExpand &&
    prev.expandItemKey === next.expandItemKey &&
    prev.onExpandContent === next.onExpandContent &&
    areInboxMessagesEquivalentForRender(prev.message, next.message)
);

export const ActivityTimeline = React.memo(function ActivityTimeline({
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
  currentLeadSessionId,
  isTeamAlive,
  leadActivity,
  leadContextUpdatedAt,
  teamNames = EMPTY_TEAM_NAMES,
  teamColorByName = EMPTY_TEAM_COLOR_MAP,
  onTeamClick,
  onExpandItem,
  onExpandContent,
}: ActivityTimelineProps): React.JSX.Element {
  const [visibleCount, setVisibleCount] = useState(MESSAGES_PAGE_SIZE);
  const rootRef = useRef<HTMLDivElement>(null);
  const [compactHeader, setCompactHeader] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const updateCompactMode = (width: number): void => {
      setCompactHeader((prev) => {
        const next = width < COMPACT_MESSAGES_WIDTH_PX;
        return prev === next ? prev : next;
      });
    };

    updateCompactMode(el.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateCompactMode(entry.contentRect.width);
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const ctx = useMemo(() => buildMessageContext(members), [members]);
  const { colorMap, localMemberNames, memberInfo } = ctx;

  const handleMemberNameClick = useCallback(
    (name: string) => {
      const member = members?.find(
        (candidate) => candidate.name === name || candidate.agentType === name
      );
      if (member) onMemberClick?.(member);
    },
    [members, onMemberClick]
  );

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
        if (isCompactionMessage(item.message)) continue;
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

  // Precompute, per timeline index, the most recent session anchor that appears
  // strictly earlier in the list. Replaces an O(n) backward scan during render
  // with an O(1) lookup; total work drops from O(n^2) to O(n) per timelineItems
  // change.
  const previousSessionAnchorByIndex = useMemo<readonly (string | undefined)[]>(() => {
    const anchors: (string | undefined)[] = [];
    let lastSeen: string | undefined;
    for (const item of timelineItems) {
      anchors.push(lastSeen);
      const anchor = getItemSessionAnchorId(item);
      if (anchor) lastSeen = anchor;
    }
    return anchors;
  }, [timelineItems]);

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
  const getItemCollapseProps = useCallback(
    (stableKey: string, itemIndex: number): ItemCollapseProps => {
      const collapseState = resolveTimelineCollapseState({
        allCollapsed,
        itemIndex,
        newestMessageIndex,
        isPinnedThoughtGroup: itemIndex === 0 && pinnedThoughtGroup != null,
        isExpandedOverride: expandOverrides?.has(stableKey) ?? false,
        onToggleOverride: onToggleExpandOverride
          ? () => onToggleExpandOverride(stableKey)
          : undefined,
      });

      if (collapseState.mode !== DEFAULT_COLLAPSE_MODE) {
        return {
          collapseMode: collapseState.mode,
          isCollapsed: collapseState.isCollapsed,
          canToggleCollapse: collapseState.canToggle,
          collapseToggleKey: collapseState.canToggle ? stableKey : undefined,
        };
      }

      return {
        collapseMode: DEFAULT_COLLAPSE_MODE,
        isCollapsed: false,
        canToggleCollapse: false,
      };
    },
    [allCollapsed, newestMessageIndex, pinnedThoughtGroup, expandOverrides, onToggleExpandOverride]
  );

  if (messages.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-3 pl-5 text-xs text-[var(--color-text-muted)]">
        <p>No messages</p>
        <p className="mt-1 text-[11px]">Send a message to a member to see activity.</p>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="space-y-1">
      {/* Pinned (newest) thought group — always at top */}
      {pinnedThoughtGroup &&
        (() => {
          const { group } = pinnedThoughtGroup;
          const firstThought = group.thoughts[0];
          const pinnedCanBeLive = currentLeadSessionId
            ? firstThought.leadSessionId === currentLeadSessionId
            : true;
          const info = memberInfo.get(firstThought.from);
          const itemKey = getThoughtGroupKey(group);
          const stableKey = itemKey;
          const collapseProps = getItemCollapseProps(stableKey, 0);
          return (
            <LeadThoughtsGroupRow
              key={itemKey}
              group={group}
              memberColor={info?.color}
              canBeLive={pinnedCanBeLive}
              isTeamAlive={pinnedCanBeLive ? isTeamAlive : undefined}
              leadActivity={pinnedCanBeLive ? leadActivity : undefined}
              leadContextUpdatedAt={pinnedCanBeLive ? leadContextUpdatedAt : undefined}
              isNew={newItemKeys.has(itemKey)}
              onVisible={onMessageVisible}
              zebraShade={zebraShadeSet.has(0)}
              collapseMode={collapseProps.collapseMode}
              isCollapsed={collapseProps.isCollapsed}
              canToggleCollapse={collapseProps.canToggleCollapse}
              collapseToggleKey={collapseProps.collapseToggleKey}
              onToggleCollapse={onToggleExpandOverride}
              onTaskIdClick={onTaskIdClick}
              memberColorMap={colorMap}
              onReply={onReplyToMessage}
              compactHeader={compactHeader}
              teamNames={teamNames}
              teamColorByName={teamColorByName}
              onTeamClick={onTeamClick}
              onExpand={compactHeader ? onExpandItem : undefined}
              expandItemKey={compactHeader ? itemKey : undefined}
            />
          );
        })()}

      {/* Remaining items */}
      {timelineItems.slice(startIndex).map((item, index) => {
        const realIndex = index + startIndex;

        // Session boundary separator (messages sorted desc — new on top)
        let sessionSeparator: React.JSX.Element | null = null;
        if (realIndex > 0) {
          const currSessionId = getItemSessionAnchorId(item);
          const prevSessionId = previousSessionAnchorByIndex[realIndex];
          if (prevSessionId && currSessionId && prevSessionId !== currSessionId) {
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

        if (item.type === 'lead-thoughts') {
          const { group } = item;
          const firstThought = group.thoughts[0];
          const info = memberInfo.get(firstThought.from);
          const itemKey = getThoughtGroupKey(group);
          const stableKey = itemKey;
          const collapseProps = getItemCollapseProps(stableKey, realIndex);
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
                collapseMode={collapseProps.collapseMode}
                isCollapsed={collapseProps.isCollapsed}
                canToggleCollapse={collapseProps.canToggleCollapse}
                collapseToggleKey={collapseProps.collapseToggleKey}
                onToggleCollapse={onToggleExpandOverride}
                onTaskIdClick={onTaskIdClick}
                memberColorMap={colorMap}
                onReply={onReplyToMessage}
                compactHeader={compactHeader}
                teamNames={teamNames}
                teamColorByName={teamColorByName}
                onTeamClick={onTeamClick}
                onExpand={compactHeader ? onExpandItem : undefined}
                expandItemKey={compactHeader ? itemKey : undefined}
              />
            </React.Fragment>
          );
        }

        const { message } = item;

        // Compaction boundary — render as a divider instead of a regular message card
        if (isCompactionMessage(message)) {
          const messageKey = toMessageKey(message);
          return (
            <React.Fragment key={messageKey}>
              {sessionSeparator}
              <CompactionDivider message={message} />
            </React.Fragment>
          );
        }

        const renderProps = resolveMessageRenderProps(message, ctx);
        const messageKey = toMessageKey(message);
        const stableKey = messageKey;
        const collapseProps = getItemCollapseProps(stableKey, realIndex);
        const isUnread = readState
          ? !message.read && !readState.readSet.has(readState.getMessageKey(message))
          : !message.read;
        return (
          <React.Fragment key={messageKey}>
            {sessionSeparator}
            <MemoizedMessageRowWithObserver
              message={message}
              teamName={teamName}
              memberRole={renderProps.memberRole}
              memberColor={renderProps.memberColor}
              recipientColor={renderProps.recipientColor}
              isUnread={isUnread}
              isNew={newItemKeys.has(messageKey)}
              zebraShade={zebraShadeSet.has(realIndex)}
              memberColorMap={colorMap}
              localMemberNames={localMemberNames}
              onMemberNameClick={onMemberClick ? handleMemberNameClick : undefined}
              onCreateTask={onCreateTaskFromMessage}
              onReply={onReplyToMessage}
              onVisible={onMessageVisible}
              onTaskIdClick={onTaskIdClick}
              onRestartTeam={onRestartTeam}
              collapseMode={collapseProps.collapseMode}
              isCollapsed={collapseProps.isCollapsed}
              canToggleCollapse={collapseProps.canToggleCollapse}
              collapseToggleKey={collapseProps.collapseToggleKey}
              onToggleCollapse={onToggleExpandOverride}
              compactHeader={compactHeader}
              teamNames={teamNames}
              teamColorByName={teamColorByName}
              onTeamClick={onTeamClick}
              onExpand={compactHeader ? onExpandItem : undefined}
              expandItemKey={compactHeader ? messageKey : undefined}
              onExpandContent={onExpandContent}
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
});
