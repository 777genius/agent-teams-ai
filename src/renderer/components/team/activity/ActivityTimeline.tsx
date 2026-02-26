import { useEffect, useMemo, useRef, useState } from 'react';

import { buildMemberColorMap } from '@renderer/utils/memberHelpers';

import { ActivityItem } from './ActivityItem';

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
  onMemberNameClick,
  onCreateTask,
  onReply,
  onVisible,
  onTaskIdClick,
}: {
  message: InboxMessage;
  teamName: string;
  memberRole?: string;
  memberColor?: string;
  recipientColor?: string;
  isUnread?: boolean;
  onMemberNameClick?: (name: string) => void;
  onCreateTask?: (subject: string, description: string) => void;
  onReply?: (message: InboxMessage) => void;
  onVisible?: (message: InboxMessage) => void;
  onTaskIdClick?: (taskId: string) => void;
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
    <div ref={ref} className="min-h-px">
      <ActivityItem
        message={message}
        teamName={teamName}
        memberRole={memberRole}
        memberColor={memberColor}
        recipientColor={recipientColor}
        isUnread={isUnread}
        onMemberNameClick={onMemberNameClick}
        onCreateTask={onCreateTask}
        onReply={onReply}
        onTaskIdClick={onTaskIdClick}
      />
    </div>
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
}: ActivityTimelineProps): React.JSX.Element => {
  const [visibleCount, setVisibleCount] = useState(MESSAGES_PAGE_SIZE);

  // Track whether the user was seeing ALL messages (no hidden ones).
  // If so, auto-expand when new messages push count past the limit,
  // so previously visible messages don't silently disappear.
  const wasShowingAllRef = useRef(messages.length <= MESSAGES_PAGE_SIZE);

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
        memberInfo.set('user', { role: leadInfo.role, color: colorMap.get('user') });
      }
    }
  }

  const handleMemberNameClick = (name: string): void => {
    const member = members?.find((m) => m.name === name || m.agentType === name);
    if (member) onMemberClick?.(member);
  };

  const hiddenCount = Math.max(0, messages.length - visibleCount);

  // Auto-expand when user was seeing all and new messages arrive — derived state sync.
  // Reading/updating ref during render is intentional (React docs: derived state sync).
  /* eslint-disable react-hooks/refs -- ref stores previous frame's "showing all" for derived state sync */
  const wasShowingAll = wasShowingAllRef.current;
  if (wasShowingAll && hiddenCount > 0) {
    setVisibleCount(messages.length);
  }
  wasShowingAllRef.current = hiddenCount === 0;
  /* eslint-enable react-hooks/refs -- end of intentional ref access during render */

  const visibleMessages = useMemo(
    () => (hiddenCount > 0 ? messages.slice(0, visibleCount) : messages),
    [messages, visibleCount, hiddenCount]
  );

  const handleShowMore = (): void => {
    setVisibleCount((prev) => prev + MESSAGES_PAGE_SIZE);
  };

  const handleShowAll = (): void => {
    setVisibleCount(Infinity);
  };

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
      {visibleMessages.map((message, index) => {
        const info = memberInfo.get(message.from);
        const recipientInfo = message.to ? memberInfo.get(message.to) : undefined;
        const recipientColor =
          recipientInfo?.color ?? (message.to ? colorMap.get(message.to) : undefined);
        const globalIndex = index;
        const messageKey = `${message.messageId ?? globalIndex}-${message.timestamp}-${message.from}`;
        const isUnread = readState
          ? !message.read && !readState.readSet.has(readState.getMessageKey(message))
          : !message.read;
        return (
          <MessageRowWithObserver
            key={messageKey}
            message={message}
            teamName={teamName}
            memberRole={info?.role}
            memberColor={info?.color}
            recipientColor={recipientColor}
            isUnread={isUnread}
            onMemberNameClick={onMemberClick ? handleMemberNameClick : undefined}
            onCreateTask={onCreateTaskFromMessage}
            onReply={onReplyToMessage}
            onVisible={onMessageVisible}
            onTaskIdClick={onTaskIdClick}
          />
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
            <span className="h-3 w-px bg-[var(--color-border-emphasis)]" />
            <button
              onClick={handleShowMore}
              className="rounded-full px-2.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-all hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-text)]"
            >
              Show {Math.min(MESSAGES_PAGE_SIZE, hiddenCount)} more
            </button>
            {hiddenCount > MESSAGES_PAGE_SIZE && (
              <>
                <span className="h-3 w-px bg-[var(--color-border-emphasis)]" />
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
