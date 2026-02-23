import { useEffect, useRef } from 'react';

import { getMemberColorByName } from '@shared/constants/memberColors';

import { ActivityItem } from './ActivityItem';

import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

interface ActivityTimelineProps {
  messages: InboxMessage[];
  members?: ResolvedTeamMember[];
  /** Set of message keys that have been read; messages not in this set show an unread dot. */
  readSet?: Set<string>;
  /** Function to get a stable key for a message (used with readSet). */
  getMessageKey?: (message: InboxMessage) => string;
  onCreateTaskFromMessage?: (subject: string, description: string) => void;
  onReplyToMessage?: (message: InboxMessage) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  /** Called when a message enters the viewport (for marking as read). */
  onMessageVisible?: (message: InboxMessage) => void;
}

const VIEWPORT_THRESHOLD = 0.15;

const MessageRowWithObserver = ({
  message,
  memberRole,
  memberColor,
  recipientColor,
  isUnread,
  onMemberNameClick,
  onCreateTask,
  onReply,
  onVisible,
}: {
  message: InboxMessage;
  memberRole?: string;
  memberColor?: string;
  recipientColor?: string;
  isUnread?: boolean;
  onMemberNameClick?: (name: string) => void;
  onCreateTask?: (subject: string, description: string) => void;
  onReply?: (message: InboxMessage) => void;
  onVisible?: (message: InboxMessage) => void;
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
        memberRole={memberRole}
        memberColor={memberColor}
        recipientColor={recipientColor}
        isUnread={isUnread}
        onMemberNameClick={onMemberNameClick}
        onCreateTask={onCreateTask}
        onReply={onReply}
      />
    </div>
  );
};

export const ActivityTimeline = ({
  messages,
  members,
  readSet,
  getMessageKey,
  onCreateTaskFromMessage,
  onReplyToMessage,
  onMemberClick,
  onMessageVisible,
}: ActivityTimelineProps): React.JSX.Element => {
  const memberInfo = new Map<string, { role?: string; color?: string }>();
  if (members) {
    for (const m of members) {
      const info = {
        role: m.role ?? (m.agentType !== 'general-purpose' ? m.agentType : undefined),
        color: m.color,
      };
      memberInfo.set(m.name, info);
      if (m.agentType && m.agentType !== m.name) {
        memberInfo.set(m.agentType, info);
      }
    }
  }

  const handleMemberNameClick = (name: string): void => {
    const member = members?.find((m) => m.name === name || m.agentType === name);
    if (member) onMemberClick?.(member);
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
      {messages.slice(0, 200).map((message, index) => {
        const info = memberInfo.get(message.from);
        const recipientInfo = message.to ? memberInfo.get(message.to) : undefined;
        const recipientColor =
          recipientInfo?.color ?? (message.to ? getMemberColorByName(message.to) : undefined);
        const messageKey = `${message.messageId ?? index}-${message.timestamp}-${message.from}`;
        const isUnread =
          readSet !== undefined && getMessageKey ? !readSet.has(getMessageKey(message)) : false;
        return (
          <MessageRowWithObserver
            key={messageKey}
            message={message}
            memberRole={info?.role}
            memberColor={info?.color}
            recipientColor={recipientColor}
            isUnread={isUnread}
            onMemberNameClick={onMemberClick ? handleMemberNameClick : undefined}
            onCreateTask={onCreateTaskFromMessage}
            onReply={onReplyToMessage}
            onVisible={onMessageVisible}
          />
        );
      })}
    </div>
  );
};
