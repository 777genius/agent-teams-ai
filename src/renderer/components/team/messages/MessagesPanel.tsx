import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useTeamMessagesExpanded } from '@renderer/hooks/useTeamMessagesExpanded';
import { useTeamMessagesRead } from '@renderer/hooks/useTeamMessagesRead';
import { useStore } from '@renderer/store';
import { computePendingCrossTeamReplies } from '@renderer/utils/crossTeamPendingReplies';
import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import {
  Bell,
  CheckCheck,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronRight,
  MessageSquare,
  PanelLeftClose,
  PanelLeft,
  Search,
  X,
} from 'lucide-react';

import { ActiveTasksBlock } from '../activity/ActiveTasksBlock';
import { ActivityTimeline } from '../activity/ActivityTimeline';
import { PendingRepliesBlock } from '../activity/PendingRepliesBlock';
import { CollapsibleTeamSection } from '../CollapsibleTeamSection';
import { MessageComposer } from './MessageComposer';
import { MessagesFilterPopover } from './MessagesFilterPopover';

import type { MessagesFilterState } from './MessagesFilterPopover';
import type { ActionMode } from './ActionModeSelector';
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

export const MessagesPanel = ({
  teamName,
  position,
  onTogglePosition,
  members,
  tasks,
  messages,
  isTeamAlive,
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
}: MessagesPanelProps): React.JSX.Element => {
  const sendTeamMessage = useStore((s) => s.sendTeamMessage);
  const sendCrossTeamMessage = useStore((s) => s.sendCrossTeamMessage);
  const sendingMessage = useStore((s) => s.sendingMessage);
  const sendMessageError = useStore((s) => s.sendMessageError);
  const lastSendMessageResult = useStore((s) => s.lastSendMessageResult);

  const [messagesSearchQuery, setMessagesSearchQuery] = useState('');
  const [messagesFilter, setMessagesFilter] = useState<MessagesFilterState>({
    from: new Set(),
    to: new Set(),
    showNoise: false,
  });
  const [messagesFilterOpen, setMessagesFilterOpen] = useState(false);
  const [messagesCollapsed, setMessagesCollapsed] = useState(true);
  const [statusBlockCollapsed, setStatusBlockCollapsed] = useState(false);
  const [pendingRepliesNowMs, setPendingRepliesNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setPendingRepliesNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  const filteredMessages = useMemo(() => {
    return filterTeamMessages(messages, {
      timeWindow,
      filter: messagesFilter,
      searchQuery: messagesSearchQuery,
    });
  }, [messages, timeWindow, messagesFilter, messagesSearchQuery]);

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

  const handleMarkAllRead = useCallback(() => {
    const keys = filteredMessages
      .filter((m) => !m.read && !readSet.has(toMessageKey(m)))
      .map((m) => toMessageKey(m));
    markAllRead(keys);
  }, [filteredMessages, readSet, markAllRead]);

  const pendingCrossTeamReplies = useMemo(
    () => computePendingCrossTeamReplies(messages, pendingRepliesNowMs),
    [messages, pendingRepliesNowMs]
  );

  /** Whether the Status block has any visible items (pending replies or active tasks). */
  const hasStatusItems = useMemo(() => {
    const hasPendingReplies = Object.keys(pendingRepliesByMember).some((name) =>
      members.some((m) => m.name === name)
    );
    if (hasPendingReplies) return true;
    if (pendingCrossTeamReplies.length > 0) return true;

    const tMap = new Map(tasks.map((t) => [t.id, t]));
    return members.some((m) => {
      if (!m.currentTaskId) return false;
      const task = tMap.get(m.currentTaskId);
      if (task && (task.reviewState === 'approved' || task.status === 'completed')) return false;
      return true;
    });
  }, [members, tasks, pendingRepliesByMember, pendingCrossTeamReplies.length]);

  // Auto-clear pending replies when a member actually responds
  useEffect(() => {
    if (Object.keys(pendingRepliesByMember).length === 0) return;
    const next = { ...pendingRepliesByMember };
    let changed = false;
    for (const [memberName, sentAtMs] of Object.entries(pendingRepliesByMember)) {
      const hasReply = messages.some((m) => {
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
  }, [messages, pendingRepliesByMember, onPendingReplyChange]);

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
  const searchAndFilterBar = (
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
    <>
      <MessageComposer
        teamName={teamName}
        members={members}
        isTeamAlive={isTeamAlive}
        sending={sendingMessage}
        sendError={sendMessageError}
        lastResult={lastSendMessageResult}
        onSend={handleSend}
        onCrossTeamSend={handleCrossTeamSend}
      />
      {/* Status block: button floats right (absolute, no layout impact);
          expanded content renders full-width in normal flow. */}
      {hasStatusItems && (
        <>
          <div className="relative h-0">
            <button
              type="button"
              className="absolute -top-[19px] right-0 z-10 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
              onClick={() => setStatusBlockCollapsed((prev) => !prev)}
              aria-label={statusBlockCollapsed ? 'Expand status' : 'Collapse status'}
            >
              <ChevronRight
                size={12}
                className={`shrink-0 transition-transform duration-150 ${statusBlockCollapsed ? '' : 'rotate-90'}`}
              />
              Status
            </button>
          </div>
          {!statusBlockCollapsed && (
            <div className="mt-5">
              <PendingRepliesBlock
                members={members}
                pendingRepliesByMember={pendingRepliesByMember}
                pendingCrossTeamReplies={pendingCrossTeamReplies}
                onMemberClick={onMemberClick}
              />
              <ActiveTasksBlock
                members={members}
                tasks={tasks}
                onMemberClick={onMemberClick}
                onTaskClick={onTaskClick}
              />
            </div>
          )}
        </>
      )}
      <ActivityTimeline
        messages={filteredMessages}
        teamName={teamName}
        members={members}
        readState={{ readSet, getMessageKey: toMessageKey }}
        allCollapsed={messagesCollapsed}
        expandOverrides={expandedSet}
        onToggleExpandOverride={toggleExpandOverride}
        teamSessionIds={teamSessionIds}
        currentLeadSessionId={currentLeadSessionId}
        onMemberClick={onMemberClick}
        onCreateTaskFromMessage={onCreateTaskFromMessage}
        onReplyToMessage={onReplyToMessage}
        onMessageVisible={handleMessageVisible}
        onRestartTeam={onRestartTeam}
        onTaskIdClick={onTaskIdClick}
      />
    </>
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                onClick={() => {
                  void window.electronAPI.openExternal(
                    'https://github.com/777genius/claude-notifications-go'
                  );
                }}
              >
                <Bell size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Desktop notifications plugin</TooltipContent>
          </Tooltip>
          <div className="ml-auto">
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
        {/* Search & filter bar */}
        <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5">
          {searchAndFilterBar}
        </div>
        {/* Scrollable content */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2">
          {messagesContent}
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
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="pointer-events-auto size-6 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                onClick={(e) => {
                  e.stopPropagation();
                  void window.electronAPI.openExternal(
                    'https://github.com/777genius/claude-notifications-go'
                  );
                }}
              >
                <Bell size={12} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Desktop notifications plugin</TooltipContent>
          </Tooltip>
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
        </>
      }
      defaultOpen
      action={<div className="flex items-center gap-2 pl-2 pr-2">{searchAndFilterBar}</div>}
    >
      {messagesContent}
    </CollapsibleTeamSection>
  );
};
