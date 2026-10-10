import { MemberBadge } from '@renderer/components/team/MemberBadge';

import type { useAppTranslation } from '@features/localization/renderer';
import type { InboxMessage } from '@shared/types';

interface ActivitySenderBadgeProps {
  name: string;
  color?: string;
  teamName: string;
  isLight: boolean;
  isWideAgent: boolean;
  hideAvatar: boolean;
  compactHeader: boolean;
  isSlashCommandResult: boolean;
  resultLabel: string;
  disableHoverCard: boolean;
  onMemberNameClick?: (memberName: string) => void;
}

export const ActivitySenderBadge = ({
  name,
  color,
  teamName,
  isLight,
  isWideAgent,
  hideAvatar,
  compactHeader,
  isSlashCommandResult,
  resultLabel,
  disableHoverCard,
  onMemberNameClick,
}: Readonly<ActivitySenderBadgeProps>): React.JSX.Element => {
  const badge = isSlashCommandResult ? (
    <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium tracking-wide text-amber-300">
      {resultLabel}
    </span>
  ) : (
    <MemberBadge
      name={name}
      color={color}
      teamName={teamName}
      isLight={isLight}
      size={isWideAgent ? 'md' : undefined}
      variant="text"
      hideAvatar={hideAvatar || compactHeader}
      onClick={onMemberNameClick}
      disableHoverCard={disableHoverCard}
    />
  );

  const sender = isWideAgent ? (
    <span data-chat-sender="true" className="inline-flex items-center">
      {badge}
    </span>
  ) : (
    badge
  );
  return sender;
};

export const renderGroupRecipientBadge = (
  message: Pick<InboxMessage, 'from' | 'groupChatId' | 'groupRecipientNames'>,
  t: ReturnType<typeof useAppTranslation>['t']
): React.JSX.Element | null => {
  const targets =
    message.from === 'user' && message.groupChatId ? message.groupRecipientNames : undefined;
  return targets?.length ? (
    <span className="text-[10px] text-[var(--color-text-muted)]">
      {t('messages.groups.recipient', {
        name: targets.length === 1 ? targets[0] : t('messageComposer.recipient.all'),
      })}
    </span>
  ) : null;
};
