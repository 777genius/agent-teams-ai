import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { MessageSquare } from 'lucide-react';

interface UnreadCommentsBadgeProps {
  unreadCount: number;
  totalCount: number;
}

export const UnreadCommentsBadge = ({
  unreadCount,
  totalCount,
}: UnreadCommentsBadgeProps): React.JSX.Element | null => {
  if (totalCount === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex size-6 shrink-0 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]">
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
      </TooltipTrigger>
      <TooltipContent side="top">
        {unreadCount > 0
          ? `${unreadCount} unread comments, ${totalCount} total`
          : `${totalCount} comments`}
      </TooltipContent>
    </Tooltip>
  );
};
