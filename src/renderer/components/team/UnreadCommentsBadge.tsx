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
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0 text-[10px] font-medium ${
        unreadCount > 0
          ? 'bg-blue-500/20 text-blue-400'
          : 'bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]'
      }`}
      title={unreadCount > 0 ? `${unreadCount} unread` : 'All read'}
    >
      <MessageSquare size={10} />
      {totalCount}
    </span>
  );
};
