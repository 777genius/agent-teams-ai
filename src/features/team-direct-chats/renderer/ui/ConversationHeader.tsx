import { useAppTranslation } from '@features/localization/renderer';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { ArrowLeft } from 'lucide-react';

import { ChatUnreadBadges } from './ChatUnreadBadges';

import type { JSX, ReactNode } from 'react';

interface ConversationHeaderProps {
  title: string;
  unreadCount: number;
  attentionCount: number;
  onBack?: () => void;
  participant?: string;
  actions?: ReactNode;
}

export const ConversationHeader = ({
  title,
  unreadCount,
  attentionCount,
  onBack,
  participant,
  actions,
}: ConversationHeaderProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  const participantName =
    participant ?? (onBack && title !== t('messages.chats.teamFeed') ? title : undefined);

  return (
    <div className="flex min-w-0 items-center gap-2">
      {onBack ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-7 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              aria-label={t('messages.chats.back')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onBack}
            >
              <ArrowLeft size={15} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('messages.chats.back')}</TooltipContent>
        </Tooltip>
      ) : null}
      {participantName ? (
        <MemberBadge name={participantName} size="sm" variant="text" />
      ) : (
        <span className="min-w-0 truncate text-sm font-medium text-[var(--color-text)]">
          {title}
        </span>
      )}
      <ChatUnreadBadges unreadCount={unreadCount} attentionCount={attentionCount} />
      {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
    </div>
  );
};
