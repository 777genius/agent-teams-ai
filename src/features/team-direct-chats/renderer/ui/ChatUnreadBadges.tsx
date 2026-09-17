import { useAppTranslation } from '@features/localization/renderer';
import { Badge } from '@renderer/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';

import type { JSX } from 'react';

interface ChatUnreadBadgesProps {
  unreadCount: number;
  attentionCount: number;
}

export const ChatUnreadBadges = ({
  unreadCount,
  attentionCount,
}: ChatUnreadBadgesProps): JSX.Element | null => {
  const { t } = useAppTranslation('team');
  if (unreadCount <= 0) {
    return null;
  }

  const tooltip = [
    t('messages.chats.activityUnread', { count: unreadCount }),
    attentionCount > 0 ? t('messages.chats.attentionUnread', { count: attentionCount }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="relative inline-flex overflow-visible pr-1.5 pt-1"
          aria-label={t('messages.chats.rowAriaCounts', {
            unread: unreadCount,
            attention: attentionCount,
          })}
        >
          <Badge
            variant="secondary"
            className="h-5 min-w-5 px-1.5 text-[10px] font-semibold tabular-nums"
          >
            {unreadCount}
          </Badge>
          {attentionCount > 0 ? (
            <Badge
              variant="default"
              className="pointer-events-none absolute -right-0.5 -top-0.5 h-4 min-w-4 justify-center px-1 text-[8px] font-bold tabular-nums leading-none"
            >
              {attentionCount}
            </Badge>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
};
