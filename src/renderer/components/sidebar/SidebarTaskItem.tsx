import { useUnreadCommentCount } from '@renderer/hooks/useUnreadCommentCount';
import { useStore } from '@renderer/store';
import { format, isThisYear, isToday, isYesterday } from 'date-fns';
import { CheckCircle2, Circle, Eye, Loader2, ShieldCheck } from 'lucide-react';

import type { GlobalTask, TeamTaskStatus } from '@shared/types';
import type { LucideIcon } from 'lucide-react';

const statusConfig: Record<TeamTaskStatus, { icon: LucideIcon; color: string; label: string }> = {
  pending: { icon: Circle, color: 'text-amber-400', label: 'pending' },
  in_progress: { icon: Loader2, color: 'text-blue-400', label: 'in progress' },
  completed: { icon: CheckCircle2, color: 'text-emerald-400', label: 'completed' },
  deleted: { icon: Circle, color: 'text-zinc-500', label: 'deleted' },
};

function formatTaskDate(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return 'Yesterday';
  if (isThisYear(d)) return format(d, 'MMM d');
  return format(d, 'MMM d, yyyy');
}

interface SidebarTaskItemProps {
  task: GlobalTask;
}

export const SidebarTaskItem = ({ task }: SidebarTaskItemProps): React.JSX.Element => {
  const openTeamTab = useStore((s) => s.openTeamTab);
  const unreadCount = useUnreadCommentCount(task.teamName, task.id, task.comments);
  const cfg =
    task.kanbanColumn === 'approved'
      ? ({ icon: ShieldCheck, color: 'text-teal-400', label: 'approved' } as const)
      : task.kanbanColumn === 'review'
        ? ({ icon: Eye, color: 'text-orange-400', label: 'in review' } as const)
        : (statusConfig[task.status] ?? statusConfig.pending);
  const StatusIcon = cfg.icon;
  const dateLabel = formatTaskDate(task.createdAt);

  return (
    <button
      type="button"
      className="flex h-[48px] w-full cursor-pointer flex-col justify-center border-b px-3 py-2 text-left transition-colors hover:bg-surface-raised"
      style={{ borderColor: 'var(--color-border)' }}
      onClick={() => openTeamTab(task.teamName, undefined, task.id)}
    >
      <div className="flex w-full items-center gap-1.5 overflow-hidden">
        <span
          className="truncate text-[13px] font-medium leading-tight"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {task.subject}
        </span>
        {unreadCount > 0 && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-blue-400"
            title={`${unreadCount} unread`}
          />
        )}
        <StatusIcon className={`size-3 shrink-0 ${cfg.color}`} />
      </div>
      <div
        className="mt-0.5 flex items-center gap-1.5 text-[10px] leading-tight"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <span>{task.owner ?? 'unassigned'}</span>
        <span className="opacity-40">·</span>
        <span className="truncate">{task.teamDisplayName}</span>
        {dateLabel && (
          <>
            <span className="opacity-40">·</span>
            <span className="shrink-0">{dateLabel}</span>
          </>
        )}
      </div>
    </button>
  );
};
