import { type JSX, memo, useCallback, useState } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { MessageSquare } from 'lucide-react';

interface UnreadCommentsBadgeProps {
  unreadCount: number;
  totalCount: number;
  pulseKey?: number;
  showZero?: boolean;
  displayMode?: 'overlay' | 'inline';
}

export const UnreadCommentsBadge = memo(function UnreadCommentsBadge({
  unreadCount,
  totalCount,
  pulseKey,
  showZero = false,
  displayMode = 'overlay',
}: UnreadCommentsBadgeProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
  }, []);

  if (totalCount === 0 && !showZero) return null;

  const shouldPulse = (pulseKey ?? 0) > 0;
  const tooltipText =
    unreadCount > 0
      ? `${unreadCount} unread comments, ${totalCount} total`
      : `${totalCount} comments`;

  const badge =
    displayMode === 'inline' ? (
      <span
        key={shouldPulse ? pulseKey : 'idle'}
        className={`relative inline-flex h-5 items-center gap-1 text-[9px] leading-none ${
          shouldPulse ? 'kanban-comment-badge-pulse' : ''
        }`}
      >
        <MessageSquare size={13} />
        {unreadCount > 0 ? (
          <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-1 text-[8px] font-bold text-white">
            {unreadCount}
          </span>
        ) : null}
        <span className="font-medium tabular-nums text-[var(--color-text-muted)]">
          {totalCount}
        </span>
      </span>
    ) : (
      <span
        key={shouldPulse ? pulseKey : 'idle'}
        className={`relative inline-flex size-6 items-center justify-center ${
          shouldPulse ? 'kanban-comment-badge-pulse' : ''
        }`}
      >
        <MessageSquare size={13} />
        <span className="absolute -bottom-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-slate-200 px-0.5 text-[7px] font-bold leading-none text-slate-700 dark:bg-slate-200 dark:text-slate-900">
          {totalCount}
        </span>
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[8px] font-bold leading-none text-white shadow-sm">
            {unreadCount}
          </span>
        ) : null}
      </span>
    );

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild>
        <span
          className={`relative inline-flex shrink-0 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] ${
            displayMode === 'inline' ? 'h-5' : 'size-6'
          }`}
        >
          {badge}
        </span>
      </TooltipTrigger>
      {open ? <TooltipContent side="top">{tooltipText}</TooltipContent> : null}
    </Tooltip>
  );
});
