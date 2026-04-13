import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Sheet, type SheetRef } from 'react-modal-sheet';

import { api } from '@renderer/api';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStableTeamMentionMeta } from '@renderer/hooks/useStableTeamMentionMeta';
import { useTeamMessagesExpanded } from '@renderer/hooks/useTeamMessagesExpanded';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { useStore } from '@renderer/store';
import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { shouldExcludeInboxTextFromReplyCandidates } from '@shared/utils/idleNotificationSemantics';
import { createLogger } from '@shared/utils/logger';
import {
  CheckCheck,
  ChevronsDownUp,
  ChevronsUpDown,
  MessageSquare,
  PanelBottom,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeft,
  PanelLeftClose,
  Search,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { ActivityTimeline } from '../activity/ActivityTimeline';
import { getThoughtGroupKey, groupTimelineItems } from '../activity/LeadThoughtsGroup';
import { MessageExpandDialog } from '../activity/MessageExpandDialog';
import { CollapsibleTeamSection } from '../CollapsibleTeamSection';
import {
  getTeamMessagesSidebarUiState,
  setTeamMessagesSidebarUiState,
} from '../sidebar/teamSidebarUiState';

import { MessageComposer } from './MessageComposer';
import { MessagesFilterPopover } from './MessagesFilterPopover';
import { StatusBlock } from './StatusBlock';

import type { TimelineItem } from '../activity/LeadThoughtsGroup';
import type { ActionMode } from './ActionModeSelector';
import type { MessagesFilterState } from './MessagesFilterPopover';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { InboxMessage, ResolvedTeamMember, TaskRef, TeamTaskWithKanban } from '@shared/types';

interface TimeWindow {
  start: number;
  end: number;
}

const logger = createLogger('Component:MessagesPanel');
const MESSAGES_PANEL_FILTER_WARN_MS = 8;
const MESSAGES_PANEL_EXPANDED_ITEM_WARN_MS = 6;
const BOTTOM_SHEET_HEADER_HEIGHT = 40;
const BOTTOM_SHEET_COLLAPSED_SNAP_INDEX = 1;
const BOTTOM_SHEET_COMPOSER_SNAP_INDEX = 2;
const BOTTOM_SHEET_FULL_SNAP_INDEX = 4;

interface MessagesPanelProps {
  teamName: string;
  position: TeamMessagesPanelMode;
  onPositionChange: (position: TeamMessagesPanelMode) => void;
  mountPoint?: Element | null;
  /** Active (non-removed) members. */
  members: ResolvedTeamMember[];
  /** All team tasks. */
  tasks: TeamTaskWithKanban[];
  /** All raw messages from team data. */
  messages: InboxMessage[];
  /** Whether the team is alive. */
  isTeamAlive?: boolean;
  /** Live lead activity status for the current team. */
  leadActivity?: string;
  /** Latest lead context timestamp for the current team. */
  leadContextUpdatedAt?: string;
  /** Time window for filtering. */
  timeWindow: TimeWindow | null;
  /** Team session IDs for timeline. */
  teamSessionIds: Set<string>;
  /** Current lead session ID. */
  currentLeadSessionId?: string;
  /** Pending replies tracker (shared with parent for MemberList). */
  pendingRepliesByMember: Record<string, number>;
  /** Update pending replies tracker. */
  onPendingReplyChange: (updater: (prev: Record<string, number>) => Record<string, number>) => void;
  /** Callback when a member is clicked in the timeline. */
  onMemberClick?: (member: ResolvedTeamMember) => void;
  /** Callback when a task is clicked from timeline or status block. */
  onTaskClick?: (task: TeamTaskWithKanban) => void;
  /** Callback to open create task dialog from a message. */
  onCreateTaskFromMessage?: (subject: string, description: string) => void;
  /** Callback to open reply dialog for a message. */
  onReplyToMessage?: (message: InboxMessage) => void;
  /** Callback when "Restart team" is clicked. */
  onRestartTeam?: () => void;
  /** Callback when a task ID link is clicked. */
  onTaskIdClick?: (taskId: string) => void;
}

export const MessagesPanel = memo(function MessagesPanel({
  teamName,
  position,
  onPositionChange,
  mountPoint,
  members,
  tasks,
  messages,
  isTeamAlive,
  leadActivity,
  leadContextUpdatedAt,
  timeWindow,
  teamSessionIds,
  currentLeadSessionId,
  pendingRepliesByMember,
  onPendingReplyChange,
  onMemberClick,
  onTaskClick,
  onCreateTaskFromMessage,
  onReplyToMessage,
  onRestartTeam,
  onTaskIdClick,
}: MessagesPanelProps): React.JSX.Element {
  const {
    sendTeamMessage,
    sendCrossTeamMessage,
    sendingMessage,
    sendMessageError,
    lastSendMessageResult,
    teams,
    openTeamTab,
  } = useStore(
    useShallow((s) => ({
      sendTeamMessage: s.sendTeamMessage,
      sendCrossTeamMessage: s.sendCrossTeamMessage,
      sendingMessage: s.sendingMessage,
      sendMessageError: s.sendMessageError,
      lastSendMessageResult: s.lastSendMessageResult,
      teams: s.teams,
      openTeamTab: s.openTeamTab,
    }))
  );

  // ── Paginated message fetching ──
  // Messages are now fetched via getMessagesPage API instead of coming
  // from getTeamData. The `messages` prop is used as initial seed if non-empty.
  const PAGE_SIZE = 50;
  const [fetchedMessages, setFetchedMessages] = useState<InboxMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const fetchIdRef = useRef(0);

  // Initial fetch on mount or team change
  useEffect(() => {
    const id = ++fetchIdRef.current;
    setMessagesLoading(true);
    void (async () => {
      try {
        const page = await api.teams.getMessagesPage(teamName, { limit: PAGE_SIZE });
        if (fetchIdRef.current !== id) return;
        setFetchedMessages(page.messages);
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch {
        // Fallback: use prop messages if API fails
        if (fetchIdRef.current === id && messages.length > 0) {
          setFetchedMessages(messages);
        }
      } finally {
        if (fetchIdRef.current === id) setMessagesLoading(false);
      }
    })();
  }, [teamName]); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally only on teamName change

  // Auto-refresh: poll for NEW messages only (prepend to head).
  // Does NOT touch nextCursor/hasMore — those belong to the "Load older" flow.
  useEffect(() => {
    if (!isTeamAlive && leadActivity !== 'active') return;
    const interval = setInterval(async () => {
      try {
        const page = await api.teams.getMessagesPage(teamName, { limit: PAGE_SIZE });
        setFetchedMessages((prev) => mergeTeamMessages(prev, page.messages));
      } catch {
        // best-effort
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [teamName, isTeamAlive, leadActivity]);

  const loadOlderMessages = useCallback(async () => {
    if (!nextCursor || messagesLoading) return;
    setMessagesLoading(true);
    try {
      const page = await api.teams.getMessagesPage(teamName, {
        beforeTimestamp: nextCursor,
        limit: PAGE_SIZE,
      });
      setFetchedMessages((prev) => mergeTeamMessages(prev, page.messages));
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      // best-effort
    } finally {
      setMessagesLoading(false);
    }
  }, [teamName, nextCursor, messagesLoading]);

  // Use fetched messages, fall back to prop messages during initial load
  const effectiveMessages = useMemo(() => {
    if (fetchedMessages.length === 0) return messages;
    return mergeTeamMessages(fetchedMessages, messages);
  }, [fetchedMessages, messages]);

  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
  const bottomSheetRef = useRef<SheetRef>(null);
  const bottomSheetStickyTopRef = useRef<HTMLDivElement | null>(null);
  const handleExpandContent = useCallback(() => {
    // no-op: user is reading expanded content, not composing
  }, []);

  const initialSidebarStateRef = useRef(getTeamMessagesSidebarUiState(teamName));
  const [messagesSearchQuery, setMessagesSearchQuery] = useState(
    initialSidebarStateRef.current.messagesSearchQuery
  );
  const [messagesFilter, setMessagesFilter] = useState<MessagesFilterState>(
    initialSidebarStateRef.current.messagesFilter
  );
  const [messagesFilterOpen, setMessagesFilterOpen] = useState(
    initialSidebarStateRef.current.messagesFilterOpen
  );
  const [messagesCollapsed, setMessagesCollapsed] = useState(
    initialSidebarStateRef.current.messagesCollapsed
  );
  const [messagesSearchBarVisible, setMessagesSearchBarVisible] = useState(
    initialSidebarStateRef.current.messagesSearchBarVisible
  );
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(
    initialSidebarStateRef.current.expandedItemKey
  );
  const [messagesScrollTop, setMessagesScrollTop] = useState(
    initialSidebarStateRef.current.messagesScrollTop
  );
  const [bottomSheetSnapIndex, setBottomSheetSnapIndex] = useState(
    initialSidebarStateRef.current.bottomSheetSnapIndex
  );
  const [bottomSheetStickyTopHeight, setBottomSheetStickyTopHeight] = useState(196);
  const [bottomSheetMountHeight, setBottomSheetMountHeight] = useState(0);

  useEffect(() => {
    initialSidebarStateRef.current = getTeamMessagesSidebarUiState(teamName);
    setMessagesSearchQuery(initialSidebarStateRef.current.messagesSearchQuery);
    setMessagesFilter(initialSidebarStateRef.current.messagesFilter);
    setMessagesFilterOpen(initialSidebarStateRef.current.messagesFilterOpen);
    setMessagesCollapsed(initialSidebarStateRef.current.messagesCollapsed);
    setMessagesSearchBarVisible(initialSidebarStateRef.current.messagesSearchBarVisible);
    setExpandedItemKey(initialSidebarStateRef.current.expandedItemKey);
    setMessagesScrollTop(initialSidebarStateRef.current.messagesScrollTop);
    setBottomSheetSnapIndex(initialSidebarStateRef.current.bottomSheetSnapIndex);
  }, [teamName]);

  useEffect(() => {
    setTeamMessagesSidebarUiState(teamName, {
      messagesSearchQuery,
      messagesFilter,
      messagesFilterOpen,
      messagesCollapsed,
      messagesSearchBarVisible,
      expandedItemKey,
      messagesScrollTop,
      bottomSheetSnapIndex,
    });
  }, [
    teamName,
    messagesSearchQuery,
    messagesFilter,
    messagesFilterOpen,
    messagesCollapsed,
    messagesSearchBarVisible,
    expandedItemKey,
    messagesScrollTop,
    bottomSheetSnapIndex,
  ]);

  useLayoutEffect(() => {
    if (position !== 'sidebar') return;
    const el = sidebarScrollRef.current;
    if (!el) return;
    el.scrollTop = messagesScrollTop;
  }, [position, messagesScrollTop]);

  useLayoutEffect(() => {
    if (position !== 'bottom-sheet' || typeof ResizeObserver === 'undefined') return;

    const mountPointElement = mountPoint instanceof HTMLElement ? mountPoint : null;
    const observedEntries: [Element | null, (height: number) => void][] = [
      [bottomSheetStickyTopRef.current, setBottomSheetStickyTopHeight],
      [mountPointElement, setBottomSheetMountHeight],
    ];
    const observers: ResizeObserver[] = [];

    for (const [element, setHeight] of observedEntries) {
      if (!element) continue;

      const updateHeight = () => {
        const nextHeight = Math.ceil(element.getBoundingClientRect().height);
        if (nextHeight > 0) {
          setHeight(nextHeight);
        }
      };

      updateHeight();

      const observer = new ResizeObserver(() => {
        updateHeight();
      });
      observer.observe(element);
      observers.push(observer);
    }

    return () => {
      observers.forEach((observer) => observer.disconnect());
    };
  }, [position, mountPoint]);

  const filteredMessages = useMemo(() => {
    const startedAt = performance.now();
    const result = filterTeamMessages(effectiveMessages, {
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
    const ms = performance.now() - startedAt;
    if (ms >= MESSAGES_PANEL_FILTER_WARN_MS) {
      logger.warn(
        `[perf] filter team=${teamName} stage=messages ms=${ms.toFixed(1)} input=${effectiveMessages.length} output=${result.length} searchLen=${messagesSearchQuery.trim().length} noise=${
          messagesFilter.showNoise ? 'on' : 'off'
        }`
      );
    }
    return result;
  }, [effectiveMessages, messagesFilter, messagesSearchQuery, teamName, timeWindow]);

  const activityTimelineMessages = useMemo(() => {
    const startedAt = performance.now();
    const result = filterTeamMessages(effectiveMessages, {
      includePassiveIdlePeerSummariesWhenNoiseHidden: true,
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
    const ms = performance.now() - startedAt;
    if (ms >= MESSAGES_PANEL_FILTER_WARN_MS) {
      logger.warn(
        `[perf] filter team=${teamName} stage=timeline ms=${ms.toFixed(1)} input=${effectiveMessages.length} output=${result.length} searchLen=${messagesSearchQuery.trim().length} noise=${
          messagesFilter.showNoise ? 'on' : 'off'
        }`
      );
    }
    return result;
  }, [effectiveMessages, messagesFilter, messagesSearchQuery, teamName, timeWindow]);

  const replyCandidateMessages = useMemo(
    () =>
      effectiveMessages.filter(
        (m) =>
          m.messageKind !== 'task_comment_notification' &&
          !shouldExcludeInboxTextFromReplyCandidates(typeof m.text === 'string' ? m.text : '')
      ),
    [effectiveMessages]
  );

  // Resolve the expanded item from filtered messages
  const expandedItem = useMemo<TimelineItem | null>(() => {
    const startedAt = performance.now();
    if (!expandedItemKey) return null;
    if (!expandedItemKey.startsWith('thoughts-')) {
      const msg = activityTimelineMessages.find((m) => toMessageKey(m) === expandedItemKey);
      const result: TimelineItem | null = msg ? { type: 'message', message: msg } : null;
      const ms = performance.now() - startedAt;
      if (ms >= MESSAGES_PANEL_EXPANDED_ITEM_WARN_MS) {
        logger.warn(
          `[perf] expandedItem team=${teamName} ms=${ms.toFixed(1)} mode=message timelineMessages=${activityTimelineMessages.length}`
        );
      }
      return result;
    }
    const allItems = groupTimelineItems(activityTimelineMessages);
    const result =
      allItems.find(
        (item) =>
          item.type === 'lead-thoughts' && getThoughtGroupKey(item.group) === expandedItemKey
      ) ?? null;
    const ms = performance.now() - startedAt;
    if (ms >= MESSAGES_PANEL_EXPANDED_ITEM_WARN_MS) {
      logger.warn(
        `[perf] expandedItem team=${teamName} ms=${ms.toFixed(1)} mode=thoughts timelineMessages=${activityTimelineMessages.length} groups=${allItems.length}`
      );
    }
    return result;
  }, [expandedItemKey, activityTimelineMessages, teamName]);

  // Auto-clear stale expanded key
  useEffect(() => {
    if (expandedItemKey && expandedItem === null) {
      setExpandedItemKey(null);
    }
  }, [expandedItemKey, expandedItem]);

  const handleExpandItem = useCallback((key: string) => {
    setExpandedItemKey(key);
  }, []);

  const handleExpandDialogChange = useCallback((open: boolean) => {
    if (!open) setExpandedItemKey(null);
  }, []);

  const { readSet, markRead, markAllRead } = useTeamMessagesRead(teamName);
  const { expandedSet, toggle: toggleExpandOverride } = useTeamMessagesExpanded(teamName);

  const messagesUnreadCount = useMemo(
    () => filteredMessages.filter((m) => !m.read && !readSet.has(toMessageKey(m))).length,
    [filteredMessages, readSet]
  );

  const handleMessageVisible = useCallback(
    (message: InboxMessage) => markRead(toMessageKey(message)),
    [markRead]
  );

  const readState = useMemo(() => ({ readSet, getMessageKey: toMessageKey }), [readSet]);

  const { teamNames, teamColorByName } = useStableTeamMentionMeta(teams);

  const handleMarkAllRead = useCallback(() => {
    const keys = filteredMessages
      .filter((m) => !m.read && !readSet.has(toMessageKey(m)))
      .map((m) => toMessageKey(m));
    markAllRead(keys);
  }, [filteredMessages, readSet, markAllRead]);

  // Auto-clear pending replies when a member actually responds
  useEffect(() => {
    if (Object.keys(pendingRepliesByMember).length === 0) return;
    const next = { ...pendingRepliesByMember };
    let changed = false;
    for (const [memberName, sentAtMs] of Object.entries(pendingRepliesByMember)) {
      const hasReply = replyCandidateMessages.some((m) => {
        if (m.from !== memberName) return false;
        const ts = Date.parse(m.timestamp);
        return Number.isFinite(ts) && ts > sentAtMs;
      });
      if (hasReply) {
        delete next[memberName];
        changed = true;
      }
    }
    if (changed) onPendingReplyChange(() => next);
  }, [onPendingReplyChange, pendingRepliesByMember, replyCandidateMessages]);

  const handleSend = useCallback(
    (
      member: string,
      text: string,
      summary?: string,
      attachments?: Parameters<typeof sendTeamMessage>[1] extends { attachments?: infer A }
        ? A
        : never,
      actionMode?: ActionMode,
      taskRefs?: TaskRef[]
    ) => {
      const sentAtMs = Date.now();
      onPendingReplyChange((prev) => ({ ...prev, [member]: sentAtMs }));
      void sendTeamMessage(teamName, {
        member,
        text,
        summary,
        attachments,
        actionMode,
        taskRefs,
      }).catch(() => {
        onPendingReplyChange((prev) => {
          if (prev[member] !== sentAtMs) return prev;
          const next = { ...prev };
          delete next[member];
          return next;
        });
      });
    },
    [teamName, sendTeamMessage, onPendingReplyChange]
  );

  const handleCrossTeamSend = useCallback(
    (
      toTeam: string,
      text: string,
      summary?: string,
      actionMode?: ActionMode,
      taskRefs?: TaskRef[]
    ) => {
      void sendCrossTeamMessage({
        fromTeam: teamName,
        fromMember: 'user',
        toTeam,
        text,
        taskRefs,
        actionMode,
        summary,
      });
    },
    [teamName, sendCrossTeamMessage]
  );

  const moveToInline = useCallback(() => {
    onPositionChange('inline');
  }, [onPositionChange]);

  const moveToSidebar = useCallback(() => {
    onPositionChange('sidebar');
  }, [onPositionChange]);

  const moveToBottomSheet = useCallback(() => {
    setBottomSheetSnapIndex(BOTTOM_SHEET_COMPOSER_SNAP_INDEX);
    onPositionChange('bottom-sheet');
  }, [onPositionChange]);

  const snapBottomSheetTo = useCallback((snapIndex: number) => {
    setBottomSheetSnapIndex(snapIndex);
    bottomSheetRef.current?.snapTo(snapIndex);
  }, []);

  const toggleBottomSheetExpansion = useCallback(() => {
    if (bottomSheetSnapIndex === BOTTOM_SHEET_COLLAPSED_SNAP_INDEX) {
      snapBottomSheetTo(BOTTOM_SHEET_COMPOSER_SNAP_INDEX);
      return;
    }
    snapBottomSheetTo(BOTTOM_SHEET_COLLAPSED_SNAP_INDEX);
  }, [bottomSheetSnapIndex, snapBottomSheetTo]);

  const bottomSheetSnapPoints = useMemo(() => {
    const maxOpenHeight =
      bottomSheetMountHeight > 0
        ? Math.max(bottomSheetMountHeight - 1, 96)
        : Number.POSITIVE_INFINITY;
    const collapsedHeight = Math.min(BOTTOM_SHEET_HEADER_HEIGHT, maxOpenHeight);
    const composerHeight = Math.min(
      Math.max(collapsedHeight + bottomSheetStickyTopHeight, collapsedHeight + 120),
      maxOpenHeight
    );
    const centeredHeight = Math.min(
      Math.max(
        bottomSheetMountHeight > 0 ? Math.round(bottomSheetMountHeight * 0.58) : 520,
        composerHeight + 140
      ),
      maxOpenHeight
    );

    return [0, collapsedHeight, composerHeight, centeredHeight, 1];
  }, [bottomSheetMountHeight, bottomSheetStickyTopHeight]);

  const normalizedBottomSheetSnapIndex = useMemo(() => {
    return Math.min(
      Math.max(bottomSheetSnapIndex, BOTTOM_SHEET_COLLAPSED_SNAP_INDEX),
      BOTTOM_SHEET_FULL_SNAP_INDEX
    );
  }, [bottomSheetSnapIndex]);

  // ---- Shared content (used in both modes) ----
  const searchAndFilterControls = (
    <div className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1">
        <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <input
          type="text"
          placeholder="Search..."
          value={messagesSearchQuery}
          onChange={(e) => setMessagesSearchQuery(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
        />
        {messagesSearchQuery && (
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={() => setMessagesSearchQuery('')}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <MessagesFilterPopover
        teamName={teamName}
        members={members}
        filter={messagesFilter}
        messages={effectiveMessages}
        open={messagesFilterOpen}
        onOpenChange={setMessagesFilterOpen}
        onApply={setMessagesFilter}
      />
    </div>
  );

  const searchAndFilterBar = (
    <div className="flex items-center gap-2">
      {searchAndFilterControls}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-events-auto size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onClick={(e) => {
              e.stopPropagation();
              setMessagesCollapsed((v) => !v);
            }}
          >
            {messagesCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {messagesCollapsed ? 'Expand all messages' : 'Collapse all messages'}
        </TooltipContent>
      </Tooltip>
    </div>
  );

  const messagesContent = (
    <div className="pb-14">
      <MessageComposer
        teamName={teamName}
        members={members}
        isTeamAlive={isTeamAlive}
        sending={sendingMessage}
        sendError={sendMessageError}
        lastResult={lastSendMessageResult}
        textareaRef={composerTextareaRef}
        onSend={handleSend}
        onCrossTeamSend={handleCrossTeamSend}
      />
      <StatusBlock
        members={members}
        tasks={tasks}
        messages={effectiveMessages}
        pendingRepliesByMember={pendingRepliesByMember}
        layout="flow"
        position="inline"
        onMemberClick={onMemberClick}
        onTaskClick={onTaskClick}
      />
      <ActivityTimeline
        messages={activityTimelineMessages}
        teamName={teamName}
        members={members}
        readState={readState}
        allCollapsed={messagesCollapsed}
        expandOverrides={expandedSet}
        onToggleExpandOverride={toggleExpandOverride}
        teamSessionIds={teamSessionIds}
        currentLeadSessionId={currentLeadSessionId}
        isTeamAlive={isTeamAlive}
        leadActivity={leadActivity}
        leadContextUpdatedAt={leadContextUpdatedAt}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
        onTeamClick={openTeamTab}
        onMemberClick={onMemberClick}
        onCreateTaskFromMessage={onCreateTaskFromMessage}
        onReplyToMessage={onReplyToMessage}
        onMessageVisible={handleMessageVisible}
        onRestartTeam={onRestartTeam}
        onTaskIdClick={onTaskIdClick}
        onExpandItem={handleExpandItem}
        onExpandContent={handleExpandContent}
      />
      {hasMore && (
        <div className="flex justify-center py-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-text-muted"
            disabled={messagesLoading}
            onClick={() => void loadOlderMessages()}
          >
            {messagesLoading ? 'Loading...' : 'Load older messages'}
          </Button>
        </div>
      )}
      <MessageExpandDialog
        expandedItem={expandedItem}
        open={expandedItemKey !== null}
        onOpenChange={handleExpandDialogChange}
        teamName={teamName}
        members={members}
        onCreateTaskFromMessage={onCreateTaskFromMessage}
        onReplyToMessage={onReplyToMessage}
        onMemberClick={onMemberClick}
        onTaskIdClick={onTaskIdClick}
        onRestartTeam={onRestartTeam}
        teamNames={teamNames}
        teamColorByName={teamColorByName}
        onTeamClick={openTeamTab}
      />
    </div>
  );

  // ---- Sidebar mode ----
  if (position === 'sidebar') {
    return (
      <div className="flex size-full flex-col overflow-hidden bg-[var(--color-surface-sidebar)]">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-3 py-2">
          <MessageSquare size={14} className="shrink-0 text-[var(--color-text-muted)]" />
          <span className="text-sm font-medium text-[var(--color-text)]">Messages</span>
          {filteredMessages.length > 0 && (
            <Badge
              variant="secondary"
              className="px-1.5 py-0.5 text-[10px] font-normal leading-none"
            >
              {filteredMessages.length}
            </Badge>
          )}
          {messagesUnreadCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-normal leading-none text-blue-600 dark:text-blue-400"
                >
                  {messagesUnreadCount} new
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom">{messagesUnreadCount} unread</TooltipContent>
            </Tooltip>
          )}
          {messagesUnreadCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-blue-400 transition-colors hover:bg-blue-500/10"
                  onClick={handleMarkAllRead}
                >
                  <CheckCheck size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Mark all as read</TooltipContent>
            </Tooltip>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={() => setMessagesCollapsed((v) => !v)}
                  aria-label={messagesCollapsed ? 'Expand all messages' : 'Collapse all messages'}
                >
                  {messagesCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {messagesCollapsed ? 'Expand all messages' : 'Collapse all messages'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={() => setMessagesSearchBarVisible((v) => !v)}
                  aria-label={
                    messagesSearchBarVisible ? 'Hide message search' : 'Show message search'
                  }
                >
                  {messagesSearchBarVisible ? <X size={14} /> : <Search size={14} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {messagesSearchBarVisible ? 'Hide search' : 'Search messages'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={moveToInline}
                  aria-label="Move messages to inline panel"
                >
                  <PanelLeftClose size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Move to inline</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {/* Search & filter bar (toggleable) */}
        {messagesSearchBarVisible && (
          <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5">
            {searchAndFilterControls}
          </div>
        )}
        {/* Scrollable content */}
        <div
          ref={sidebarScrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-14 pr-3 pt-2"
          onScroll={(e) => setMessagesScrollTop(e.currentTarget.scrollTop)}
        >
          <div className="pl-3">
            <MessageComposer
              teamName={teamName}
              members={members}
              isTeamAlive={isTeamAlive}
              sending={sendingMessage}
              sendError={sendMessageError}
              lastResult={lastSendMessageResult}
              textareaRef={composerTextareaRef}
              onSend={handleSend}
              onCrossTeamSend={handleCrossTeamSend}
            />
            <StatusBlock
              members={members}
              tasks={tasks}
              messages={effectiveMessages}
              pendingRepliesByMember={pendingRepliesByMember}
              layout="flow"
              position="sidebar"
              onMemberClick={onMemberClick}
              onTaskClick={onTaskClick}
            />{' '}
          </div>
          <ActivityTimeline
            messages={activityTimelineMessages}
            teamName={teamName}
            members={members}
            readState={readState}
            allCollapsed={messagesCollapsed}
            expandOverrides={expandedSet}
            onToggleExpandOverride={toggleExpandOverride}
            teamSessionIds={teamSessionIds}
            currentLeadSessionId={currentLeadSessionId}
            isTeamAlive={isTeamAlive}
            leadActivity={leadActivity}
            leadContextUpdatedAt={leadContextUpdatedAt}
            teamNames={teamNames}
            teamColorByName={teamColorByName}
            onTeamClick={openTeamTab}
            onMemberClick={onMemberClick}
            onCreateTaskFromMessage={onCreateTaskFromMessage}
            onReplyToMessage={onReplyToMessage}
            onMessageVisible={handleMessageVisible}
            onRestartTeam={onRestartTeam}
            onTaskIdClick={onTaskIdClick}
            onExpandItem={handleExpandItem}
            onExpandContent={handleExpandContent}
          />
          {hasMore && (
            <div className="flex justify-center py-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-text-muted"
                disabled={messagesLoading}
                onClick={() => void loadOlderMessages()}
              >
                {messagesLoading ? 'Loading...' : 'Load older messages'}
              </Button>
            </div>
          )}
          <MessageExpandDialog
            expandedItem={expandedItem}
            open={expandedItemKey !== null}
            onOpenChange={handleExpandDialogChange}
            teamName={teamName}
            members={members}
            onCreateTaskFromMessage={onCreateTaskFromMessage}
            onReplyToMessage={onReplyToMessage}
            onMemberClick={onMemberClick}
            onTaskIdClick={onTaskIdClick}
            onRestartTeam={onRestartTeam}
            teamNames={teamNames}
            teamColorByName={teamColorByName}
            onTeamClick={openTeamTab}
          />
        </div>
      </div>
    );
  }

  if (position === 'bottom-sheet') {
    if (!mountPoint) {
      return <div className="hidden" aria-hidden="true" />;
    }

    const isBottomSheetCollapsed =
      normalizedBottomSheetSnapIndex === BOTTOM_SHEET_COLLAPSED_SNAP_INDEX;

    return (
      <Sheet
        ref={bottomSheetRef}
        isOpen
        onClose={moveToInline}
        mountPoint={mountPoint}
        avoidKeyboard={false}
        detent="full"
        snapPoints={bottomSheetSnapPoints}
        initialSnap={normalizedBottomSheetSnapIndex}
        onSnap={setBottomSheetSnapIndex}
        disableDismiss
        disableScrollLocking
        style={{ zIndex: 30 }}
        className="!pointer-events-none !absolute !inset-0"
        unstyled
      >
        <Sheet.Container
          unstyled
          className="flex max-h-full w-full flex-col overflow-hidden rounded-t-[20px] border border-[var(--color-border)] bg-[var(--color-surface-sidebar)] shadow-[0_-18px_48px_rgba(0,0,0,0.35)]"
        >
          <Sheet.Header
            unstyled
            className="shrink-0 cursor-grab select-none border-b border-[var(--color-border)] bg-[var(--color-surface-sidebar)] active:cursor-grabbing"
          >
            <div className="relative h-10 px-3">
              <div className="pointer-events-none absolute inset-x-0 top-1 flex justify-center">
                <Sheet.DragIndicator
                  className="!h-1 !w-9 cursor-grab !rounded-full active:cursor-grabbing"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--color-text-muted) 45%, transparent)',
                  }}
                />
              </div>
              <div className="flex h-full items-center gap-1.5">
                <MessageSquare size={13} className="shrink-0 text-[var(--color-text-muted)]" />
                <span className="text-[13px] font-medium text-[var(--color-text)]">Messages</span>
                {filteredMessages.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="px-1 py-0 text-[9px] font-normal leading-none"
                  >
                    {filteredMessages.length}
                  </Badge>
                )}
                {messagesUnreadCount > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="secondary"
                        className="bg-blue-500/20 px-1 py-0 text-[9px] font-normal leading-none text-blue-600 dark:text-blue-400"
                      >
                        {messagesUnreadCount} new
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="top">{messagesUnreadCount} unread</TooltipContent>
                  </Tooltip>
                )}
                <div
                  className="ml-auto flex items-center gap-1"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {messagesUnreadCount > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-[22px] p-0 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                          onClick={handleMarkAllRead}
                          aria-label="Mark all messages as read"
                        >
                          <CheckCheck size={13} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">Mark all as read</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={() => setMessagesCollapsed((value) => !value)}
                        aria-label={
                          messagesCollapsed ? 'Expand all messages' : 'Collapse all messages'
                        }
                      >
                        {messagesCollapsed ? (
                          <ChevronsUpDown size={14} />
                        ) : (
                          <ChevronsDownUp size={14} />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {messagesCollapsed ? 'Expand all messages' : 'Collapse all messages'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={() => setMessagesSearchBarVisible((value) => !value)}
                        aria-label={
                          messagesSearchBarVisible ? 'Hide message search' : 'Show message search'
                        }
                      >
                        {messagesSearchBarVisible ? <X size={14} /> : <Search size={14} />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {messagesSearchBarVisible ? 'Hide search' : 'Search messages'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={toggleBottomSheetExpansion}
                        aria-label={
                          isBottomSheetCollapsed
                            ? 'Expand messages bottom sheet'
                            : 'Collapse messages bottom sheet'
                        }
                      >
                        {isBottomSheetCollapsed ? (
                          <PanelBottomOpen size={14} />
                        ) : (
                          <PanelBottomClose size={14} />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {isBottomSheetCollapsed ? 'Expand sheet' : 'Collapse sheet'}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={moveToInline}
                        aria-label="Move messages to inline panel"
                      >
                        <PanelBottom size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Move to inline</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-[22px] p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                        onClick={moveToSidebar}
                        aria-label="Move messages to sidebar"
                      >
                        <PanelLeft size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Move to sidebar</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>
          </Sheet.Header>
          {!isBottomSheetCollapsed && (
            <Sheet.Content
              className="min-h-0 bg-[var(--color-surface-sidebar)]"
              scrollClassName="flex min-h-full flex-col"
              disableDrag={(state) => state.scrollPosition !== 'top'}
            >
              <div
                ref={bottomSheetStickyTopRef}
                className="sticky top-0 z-[1] shrink-0 border-b border-[var(--color-border)] backdrop-blur"
                style={{
                  backgroundColor: 'var(--color-surface-sidebar)',
                }}
              >
                {messagesSearchBarVisible && (
                  <div className="border-b border-[var(--color-border)] px-3 py-2">
                    {searchAndFilterControls}
                  </div>
                )}
                <div className="p-3">
                  <MessageComposer
                    teamName={teamName}
                    layout="compact"
                    members={members}
                    isTeamAlive={isTeamAlive}
                    sending={sendingMessage}
                    sendError={sendMessageError}
                    lastResult={lastSendMessageResult}
                    textareaRef={composerTextareaRef}
                    onSend={handleSend}
                    onCrossTeamSend={handleCrossTeamSend}
                  />
                </div>
              </div>
              <div className="shrink-0 px-3 pt-2">
                <StatusBlock
                  members={members}
                  tasks={tasks}
                  messages={effectiveMessages}
                  pendingRepliesByMember={pendingRepliesByMember}
                  layout="flow"
                  position="inline"
                  onMemberClick={onMemberClick}
                  onTaskClick={onTaskClick}
                />
              </div>
              <div className="flex-1 px-3 pb-4 pt-2">
                <ActivityTimeline
                  messages={activityTimelineMessages}
                  teamName={teamName}
                  members={members}
                  readState={readState}
                  allCollapsed={messagesCollapsed}
                  expandOverrides={expandedSet}
                  onToggleExpandOverride={toggleExpandOverride}
                  teamSessionIds={teamSessionIds}
                  currentLeadSessionId={currentLeadSessionId}
                  isTeamAlive={isTeamAlive}
                  leadActivity={leadActivity}
                  leadContextUpdatedAt={leadContextUpdatedAt}
                  teamNames={teamNames}
                  teamColorByName={teamColorByName}
                  onTeamClick={openTeamTab}
                  onMemberClick={onMemberClick}
                  onCreateTaskFromMessage={onCreateTaskFromMessage}
                  onReplyToMessage={onReplyToMessage}
                  onMessageVisible={handleMessageVisible}
                  onRestartTeam={onRestartTeam}
                  onTaskIdClick={onTaskIdClick}
                  onExpandItem={handleExpandItem}
                  onExpandContent={handleExpandContent}
                />
                {hasMore && (
                  <div className="flex justify-center py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-text-muted"
                      disabled={messagesLoading}
                      onClick={() => void loadOlderMessages()}
                    >
                      {messagesLoading ? 'Loading...' : 'Load older messages'}
                    </Button>
                  </div>
                )}
              </div>
              <MessageExpandDialog
                expandedItem={expandedItem}
                open={expandedItemKey !== null}
                onOpenChange={handleExpandDialogChange}
                teamName={teamName}
                members={members}
                onCreateTaskFromMessage={onCreateTaskFromMessage}
                onReplyToMessage={onReplyToMessage}
                onMemberClick={onMemberClick}
                onTaskIdClick={onTaskIdClick}
                onRestartTeam={onRestartTeam}
                teamNames={teamNames}
                teamColorByName={teamColorByName}
                onTeamClick={openTeamTab}
              />
            </Sheet.Content>
          )}
        </Sheet.Container>
      </Sheet>
    );
  }

  // ---- Inline mode (wrapped in CollapsibleTeamSection) ----
  return (
    <CollapsibleTeamSection
      sectionId="messages"
      title="Messages"
      icon={<MessageSquare size={14} />}
      badge={filteredMessages.length}
      secondaryBadge={
        filteredMessages.length > 0 && messagesUnreadCount > 0 ? messagesUnreadCount : undefined
      }
      afterBadge={
        messagesUnreadCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="pointer-events-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-blue-400 transition-colors hover:bg-blue-500/10"
                onClick={(e) => {
                  e.stopPropagation();
                  handleMarkAllRead();
                }}
              >
                <CheckCheck size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Mark all as read</TooltipContent>
          </Tooltip>
        ) : undefined
      }
      headerExtra={
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                onClick={(e) => {
                  e.stopPropagation();
                  moveToBottomSheet();
                }}
                aria-label="Move messages to bottom sheet"
              >
                <PanelBottom size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Move to bottom sheet</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                onClick={(e) => {
                  e.stopPropagation();
                  moveToSidebar();
                }}
                aria-label="Move messages to sidebar"
              >
                <PanelLeft size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Move to sidebar</TooltipContent>
          </Tooltip>
        </div>
      }
      defaultOpen
      action={<div className="flex items-center gap-2 px-2">{searchAndFilterBar}</div>}
    >
      {messagesContent}
    </CollapsibleTeamSection>
  );
});
