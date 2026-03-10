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
    <span
      className={`relative inline-flex items-center gap-0.5 rounded-full bg-[var(--color-surface-raised)] py-0 text-[10px] font-medium text-[var(--color-text-muted)] ${unreadCount > 0 ? 'mr-1 pl-1.5 pr-2' : 'px-1.5'}`}
    >
      <MessageSquare size={10} />
      {totalCount}
      {unreadCount > 0 && (
        <span className="absolute -top-1 right-0 flex h-3 min-w-[12px] translate-x-[calc(50%-4px)] items-center justify-center rounded-full bg-blue-500 px-0.5 text-[8px] font-bold leading-none text-white">
          {unreadCount}
        </span>
      )}
    </span>
  );
};
