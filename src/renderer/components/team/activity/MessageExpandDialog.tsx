import { memo, useCallback, useMemo, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { sameMessageActionOwner } from '@renderer/types/messageTaskSeed';
import {
  agentAvatarUrl,
  buildMemberAvatarMap,
  displayMemberName,
} from '@renderer/utils/memberHelpers';
import { LEAD_THOUGHT_SPEAKER_NAME } from '@shared/utils/leadDetection';

import { MemberBadge } from '../MemberBadge';

import { ActivityItem } from './ActivityItem';
import { buildMessageContext, resolveMessageRenderProps } from './activityMessageContext';
import { ThoughtBodyContent } from './ThoughtBodyContent';

import type { LeadThoughtGroup, TimelineItem } from './LeadThoughtsGroup';
import type { MessageActionOwner, MessageTaskSeed } from '@renderer/types/messageTaskSeed';
import type { TaskIdClickHandler } from '@renderer/utils/taskReferenceUtils';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface DialogThoughtsContentProps {
  group: LeadThoughtGroup;
  teamName: string;
  members?: ResolvedTeamMember[];
  memberColor?: string;
  onTaskIdClick?: TaskIdClickHandler;
  onReply?: (message: InboxMessage) => void;
  memberColorMap?: Map<string, string>;
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
}

const DialogThoughtsContent = ({
  group,
  teamName,
  members,
  memberColor,
  onTaskIdClick,
  onReply,
  memberColorMap,
  teamNames = [],
  teamColorByName,
  onTeamClick,
}: DialogThoughtsContentProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { thoughts } = group;
  const newest = thoughts[0];
  const oldest = thoughts[thoughts.length - 1];
  const leadName = displayMemberName(LEAD_THOUGHT_SPEAKER_NAME);
  const colors = getTeamColorSet(memberColor ?? '');
  const avatarMap = useMemo(() => buildMemberAvatarMap(members ?? []), [members]);
  const chronological = useMemo(() => [...thoughts].reverse(), [thoughts]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 pb-3">
        <img
          src={
            avatarMap.get(LEAD_THOUGHT_SPEAKER_NAME) ??
            agentAvatarUrl(LEAD_THOUGHT_SPEAKER_NAME, 32)
          }
          alt=""
          className="size-6 rounded-full bg-[var(--color-surface-raised)]"
          loading="lazy"
        />
        <MemberBadge name={leadName} color={memberColor} hideAvatar variant="text" />
        <span className="text-[10px]" style={{ color: CARD_ICON_MUTED }}>
          {t('activity.thoughts.count', { count: thoughts.length })}
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
            teamName={teamName}
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
  actionOwner: MessageActionOwner;
  expandedOwner: MessageActionOwner | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamName: string;
  members?: ResolvedTeamMember[];
  onCreateTaskFromMessage?: (seed: MessageTaskSeed) => void;
  onReplyToMessage?: (message: InboxMessage) => void;
  revisionMessageId?: string | null;
  onReviseMessage?: (message: InboxMessage) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onTaskIdClick?: TaskIdClickHandler;
  onRestartTeam?: () => void;
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
}

export const MessageExpandDialog = memo(function MessageExpandDialog({
  expandedItem,
  actionOwner,
  expandedOwner,
  open,
  onOpenChange,
  teamName,
  members,
  onCreateTaskFromMessage,
  onReplyToMessage,
  revisionMessageId,
  onReviseMessage,
  onMemberClick,
  onTaskIdClick,
  onRestartTeam,
  teamNames = [],
  teamColorByName,
  onTeamClick,
}: MessageExpandDialogProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  // Keep last valid item for exit animation
  const lastItemRef = useRef<{ item: TimelineItem; owner: MessageActionOwner } | null>(null);
  const isLiveItem = !!expandedItem && open && sameMessageActionOwner(expandedOwner, actionOwner);
  if (isLiveItem && expandedOwner)
    lastItemRef.current = { item: expandedItem, owner: expandedOwner };
  const displayItem = isLiveItem ? expandedItem : lastItemRef.current?.item;
  const displayTeamName = isLiveItem ? teamName : (lastItemRef.current?.owner.teamName ?? teamName);

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
      ? (ctx.memberInfo.get('team-lead')?.color ??
        ctx.memberInfo.get('lead')?.color ??
        ctx.memberInfo.get(displayItem.group.thoughts[0].from)?.color)
      : undefined;

  const headerTitle =
    displayItem?.type === 'message'
      ? displayItem.message.from
      : displayItem?.type === 'lead-thoughts'
        ? t('activity.thoughts.titleForMember', {
            name: displayMemberName(LEAD_THOUGHT_SPEAKER_NAME),
          })
        : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[80vw] max-w-[2000px] flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-4 pt-4">
          <DialogTitle className="text-sm">{headerTitle}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('activity.expandDialog.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {displayItem?.type === 'message' ? (
            <ActivityItem
              message={displayItem.message}
              teamName={displayTeamName}
              memberRole={renderProps?.memberRole}
              memberColor={renderProps?.memberColor}
              recipientColor={renderProps?.recipientColor}
              memberColorMap={ctx.colorMap}
              localMemberNames={ctx.localMemberNames}
              onMemberNameClick={isLiveItem && onMemberClick ? handleMemberNameClick : undefined}
              onCreateTask={isLiveItem ? onCreateTaskFromMessage : undefined}
              onReply={isLiveItem ? onReplyToMessage : undefined}
              canRevise={isLiveItem && displayItem.message.messageId === revisionMessageId}
              onRevise={isLiveItem ? onReviseMessage : undefined}
              onTaskIdClick={isLiveItem ? onTaskIdClick : undefined}
              onRestartTeam={isLiveItem ? onRestartTeam : undefined}
              compactHeader={false}
              isCollapsed={false}
              teamNames={teamNames}
              teamColorByName={teamColorByName}
              onTeamClick={isLiveItem ? onTeamClick : undefined}
            />
          ) : displayItem?.type === 'lead-thoughts' ? (
            <DialogThoughtsContent
              group={displayItem.group}
              teamName={displayTeamName}
              members={members}
              memberColor={thoughtMemberColor}
              onTaskIdClick={isLiveItem ? onTaskIdClick : undefined}
              onReply={isLiveItem ? onReplyToMessage : undefined}
              memberColorMap={ctx.colorMap}
              teamNames={teamNames}
              teamColorByName={teamColorByName}
              onTeamClick={isLiveItem ? onTeamClick : undefined}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
});
