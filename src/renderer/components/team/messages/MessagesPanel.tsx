import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStableTeamMentionMeta } from '@renderer/hooks/useStableTeamMentionMeta';
import { useTeamMessagesExpanded } from '@renderer/hooks/useTeamMessagesExpanded';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import {
  CheckCheck,
  ChevronsDownUp,
  ChevronsUpDown,
  MessageSquare,
  PanelLeft,
  PanelLeftClose,
  Search,
  X,
} from 'lucide-react';

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
import type { InboxMessage, ResolvedTeamMember, TaskRef, TeamTaskWithKanban } from '@shared/types';

interface TimeWindow {
  start: number;
  end: number;
}

interface MessagesPanelProps {
  teamName: string;
  position: 'sidebar' | 'inline';
  onTogglePosition: () => void;
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
  onTogglePosition,
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

  // Auto-refresh: poll for new messages (newest page only)
  useEffect(() => {
    if (!isTeamAlive && leadActivity !== 'active') return;
    const interval = setInterval(async () => {
      try {
        const page = await api.teams.getMessagesPage(teamName, { limit: PAGE_SIZE });
        setFetchedMessages((prev) => {
          // Merge: keep older messages that aren't in the new page
          const newIds = new Set(page.messages.map((m) => m.messageId ?? m.timestamp));
          const older = prev.filter(
            (m) =>
              !newIds.has(m.messageId ?? m.timestamp) &&
              !page.messages.some((n) => n.timestamp === m.timestamp && n.from === m.from)
          );
          return [...page.messages, ...older];
        });
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
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
      setFetchedMessages((prev) => [...prev, ...page.messages]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      // best-effort
    } finally {
      setMessagesLoading(false);
    }
  }, [teamName, nextCursor, messagesLoading]);

  // Use fetched messages, fall back to prop messages during initial load
  const effectiveMessages = fetchedMessages.length > 0 ? fetchedMessages : messages;

  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);
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
  const [sidebarSearchVisible, setSidebarSearchVisible] = useState(
    initialSidebarStateRef.current.sidebarSearchVisible
  );
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(
    initialSidebarStateRef.current.expandedItemKey
  );
  const [sidebarScrollTop, setSidebarScrollTop] = useState(
    initialSidebarStateRef.current.sidebarScrollTop
  );

  useEffect(() => {
    initialSidebarStateRef.current = getTeamMessagesSidebarUiState(teamName);
    setMessagesSearchQuery(initialSidebarStateRef.current.messagesSearchQuery);
    setMessagesFilter(initialSidebarStateRef.current.messagesFilter);
    setMessagesFilterOpen(initialSidebarStateRef.current.messagesFilterOpen);
    setMessagesCollapsed(initialSidebarStateRef.current.messagesCollapsed);
    setSidebarSearchVisible(initialSidebarStateRef.current.sidebarSearchVisible);
    setExpandedItemKey(initialSidebarStateRef.current.expandedItemKey);
    setSidebarScrollTop(initialSidebarStateRef.current.sidebarScrollTop);
  }, [teamName]);

  useEffect(() => {
    setTeamMessagesSidebarUiState(teamName, {
      messagesSearchQuery,
      messagesFilter,
      messagesFilterOpen,
      messagesCollapsed,
      sidebarSearchVisible,
      expandedItemKey,
      sidebarScrollTop,
    });
  }, [
    teamName,
    messagesSearchQuery,
    messagesFilter,
    messagesFilterOpen,
    messagesCollapsed,
    sidebarSearchVisible,
    expandedItemKey,
    sidebarScrollTop,
  ]);

  useLayoutEffect(() => {
    if (position !== 'sidebar') return;
    const el = sidebarScrollRef.current;
    if (!el) return;
    el.scrollTop = sidebarScrollTop;
  }, [position, sidebarScrollTop]);

  const filteredMessages = useMemo(() => {
    return filterTeamMessages(effectiveMessages, {
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
  }, [effectiveMessages, timeWindow, messagesFilter, messagesSearchQuery]);

  // Resolve the expanded item from filtered messages
  const expandedItem = useMemo<TimelineItem | null>(() => {
    if (!expandedItemKey) return null;
    if (!expandedItemKey.startsWith('thoughts-')) {
      const msg = filteredMessages.find((m) => toMessageKey(m) === expandedItemKey);
      return msg ? { type: 'message', message: msg } : null;
    }
    const allItems = groupTimelineItems(filteredMessages);
    return (
      allItems.find(
        (item) =>
          item.type === 'lead-thoughts' && getThoughtGroupKey(item.group) === expandedItemKey
      ) ?? null
    );
  }, [expandedItemKey, filteredMessages]);

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
      const hasReply = effectiveMessages.some((m) => {
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
  }, [effectiveMessages, pendingRepliesByMember, onPendingReplyChange]);

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
        filter={messagesFilter}
        messages={messages}
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
        messages={messages}
        pendingRepliesByMember={pendingRepliesByMember}
        position="inline"
        onMemberClick={onMemberClick}
        onTaskClick={onTaskClick}
      />
      <ActivityTimeline
        messages={filteredMessages}
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
      <div className="flex size-full flex-col overflow-hidden bg-[var(--color-surface)]">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-section-bg)] px-3 py-2">
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
                  onClick={() => setSidebarSearchVisible((v) => !v)}
                >
                  {sidebarSearchVisible ? <X size={14} /> : <Search size={14} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {sidebarSearchVisible ? 'Hide search' : 'Search messages'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                  onClick={onTogglePosition}
                >
                  <PanelLeftClose size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Move to inline</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {/* Search & filter bar (toggleable) */}
        {sidebarSearchVisible && (
          <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5">
            {searchAndFilterControls}
          </div>
        )}
        {/* Scrollable content */}
        <div
          ref={sidebarScrollRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-14 pr-3 pt-2"
          onScroll={(e) => setSidebarScrollTop(e.currentTarget.scrollTop)}
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
              messages={messages}
              pendingRepliesByMember={pendingRepliesByMember}
              position="sidebar"
              onMemberClick={onMemberClick}
              onTaskClick={onTaskClick}
            />{' '}
          </div>
          <ActivityTimeline
            messages={filteredMessages}
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePosition();
              }}
            >
              <PanelLeft size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Move to sidebar</TooltipContent>
        </Tooltip>
      }
      defaultOpen
      action={<div className="flex items-center gap-2 px-2">{searchAndFilterBar}</div>}
    >
      {messagesContent}
    </CollapsibleTeamSection>
  );
});
