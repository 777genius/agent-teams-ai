import { memo, useCallback, useMemo, useRef } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { agentAvatarUrl } from '@renderer/utils/memberHelpers';

import { ActivityItem } from './ActivityItem';
import { buildMessageContext, resolveMessageRenderProps } from './activityMessageContext';
import { MemberBadge } from '../MemberBadge';
import { ThoughtBodyContent } from './ThoughtBodyContent';

import type { TimelineItem, LeadThoughtGroup } from './LeadThoughtsGroup';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface DialogThoughtsContentProps {
  group: LeadThoughtGroup;
  memberColor?: string;
  onTaskIdClick?: (taskId: string) => void;
  onReply?: (message: InboxMessage) => void;
  memberColorMap?: Map<string, string>;
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
}

const DialogThoughtsContent = ({
  group,
  memberColor,
  onTaskIdClick,
  onReply,
  memberColorMap,
  teamNames = [],
  teamColorByName,
  onTeamClick,
}: DialogThoughtsContentProps): React.JSX.Element => {
  const { thoughts } = group;
  const newest = thoughts[0];
  const oldest = thoughts[thoughts.length - 1];
  const colors = getTeamColorSet(memberColor ?? '');
  const chronological = useMemo(() => [...thoughts].reverse(), [thoughts]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 pb-3">
        <img
          src={agentAvatarUrl(newest.from, 32)}
          alt=""
          className="size-6 rounded-full bg-[var(--color-surface-raised)]"
          loading="lazy"
        />
        <MemberBadge name={newest.from} color={memberColor} hideAvatar />
        <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
          {thoughts.length} thoughts
        </span>
        <span className="ml-auto text-[10px]" style={{ color: CARD_ICON_MUTED }}>
          {formatTime(oldest.timestamp) === formatTime(newest.timestamp)
            ? formatTime(oldest.timestamp)
            : `${formatTime(oldest.timestamp)}–${formatTime(newest.timestamp)}`}
        </span>
      </div>
      {/* Body */}
      <div
        className="rounded-md"
        style={{
          border: `1px solid var(--color-border-subtle)`,
          borderLeft: `3px solid ${colors.border}`,
        }}
      >
        {chronological.map((thought, idx) => (
          <ThoughtBodyContent
            key={thought.messageId ?? idx}
            thought={thought}
            showDivider={idx > 0}
            onTaskIdClick={onTaskIdClick}
            onReply={onReply}
            memberColorMap={memberColorMap}
            teamNames={teamNames}
            teamColorByName={teamColorByName}
            onTeamClick={onTeamClick}
          />
        ))}
      </div>
    </div>
  );
};

interface MessageExpandDialogProps {
  expandedItem: TimelineItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamName: string;
  members?: ResolvedTeamMember[];
  onCreateTaskFromMessage?: (subject: string, description: string) => void;
  onReplyToMessage?: (message: InboxMessage) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onTaskIdClick?: (taskId: string) => void;
  onRestartTeam?: () => void;
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
}

export const MessageExpandDialog = memo(function MessageExpandDialog({
  expandedItem,
  open,
  onOpenChange,
  teamName,
  members,
  onCreateTaskFromMessage,
  onReplyToMessage,
  onMemberClick,
  onTaskIdClick,
  onRestartTeam,
  teamNames = [],
  teamColorByName,
  onTeamClick,
}: MessageExpandDialogProps): React.JSX.Element {
  // Keep last valid item for exit animation
  const lastItemRef = useRef<TimelineItem | null>(null);
  if (expandedItem) lastItemRef.current = expandedItem;
  const displayItem = expandedItem ?? lastItemRef.current;

  const ctx = useMemo(() => buildMessageContext(members), [members]);

  const handleMemberNameClick = useCallback(
    (name: string) => {
      const member = members?.find(
        (candidate) => candidate.name === name || candidate.agentType === name
      );
      if (member) onMemberClick?.(member);
    },
    [members, onMemberClick]
  );

  const renderProps =
    displayItem?.type === 'message' ? resolveMessageRenderProps(displayItem.message, ctx) : null;

  const thoughtMemberColor =
    displayItem?.type === 'lead-thoughts'
      ? ctx.memberInfo.get(displayItem.group.thoughts[0].from)?.color
      : undefined;

  const headerTitle =
    displayItem?.type === 'message'
      ? displayItem.message.from
      : displayItem?.type === 'lead-thoughts'
        ? `${displayItem.group.thoughts[0].from} — thoughts`
        : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[80vw] max-w-[2000px] flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-4 pt-4">
          <DialogTitle className="text-sm">{headerTitle}</DialogTitle>
          <DialogDescription className="sr-only">Expanded message view</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {displayItem?.type === 'message' ? (
            <ActivityItem
              message={displayItem.message}
              teamName={teamName}
              memberRole={renderProps?.memberRole}
              memberColor={renderProps?.memberColor}
              recipientColor={renderProps?.recipientColor}
              memberColorMap={ctx.colorMap}
              localMemberNames={ctx.localMemberNames}
              onMemberNameClick={onMemberClick ? handleMemberNameClick : undefined}
              onCreateTask={onCreateTaskFromMessage}
              onReply={onReplyToMessage}
              onTaskIdClick={onTaskIdClick}
              onRestartTeam={onRestartTeam}
              compactHeader={false}
              isCollapsed={false}
              teamNames={teamNames}
              teamColorByName={teamColorByName}
              onTeamClick={onTeamClick}
            />
          ) : displayItem?.type === 'lead-thoughts' ? (
            <DialogThoughtsContent
              group={displayItem.group}
              memberColor={thoughtMemberColor}
              onTaskIdClick={onTaskIdClick}
              onReply={onReplyToMessage}
              memberColorMap={ctx.colorMap}
              teamNames={teamNames}
              teamColorByName={teamColorByName}
              onTeamClick={onTeamClick}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
});
