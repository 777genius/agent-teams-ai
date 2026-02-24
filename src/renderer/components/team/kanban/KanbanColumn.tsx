import { Badge } from '@renderer/components/ui/badge';
import { cn } from '@renderer/lib/utils';
import { Plus } from 'lucide-react';

interface KanbanColumnProps {
  title: string;
  count: number;
  icon?: React.ReactNode;
  headerBg?: string;
  bodyBg?: string;
  onAddTask?: () => void;
  children: React.ReactNode;
}

export const KanbanColumn = ({
  title,
  count,
  icon,
  headerBg,
  bodyBg,
  onAddTask,
  children,
}: KanbanColumnProps): React.JSX.Element => {
  return (
    <section
      className={cn(
        'rounded-md border border-[var(--color-border)]',
        !bodyBg && 'bg-[var(--color-surface)]'
      )}
      style={bodyBg ? { backgroundColor: bodyBg } : undefined}
    >
      <header
        className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2"
        style={headerBg ? { backgroundColor: headerBg } : undefined}
      >
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text)]">
          {icon}
          {title}
        </h4>
        <div className="flex items-center gap-1.5">
          {onAddTask ? (
            <button
              type="button"
              onClick={onAddTask}
              className="inline-flex size-5 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-white/10 hover:text-[var(--color-text)]"
              aria-label={`Add task to ${title}`}
            >
              <Plus size={13} />
            </button>
          ) : null}
          <Badge variant="secondary" className="px-2 py-0.5 text-[10px] font-normal">
            {count}
          </Badge>
        </div>
      </header>
      <div className="flex max-h-[480px] flex-col gap-2 overflow-auto p-2">{children}</div>
    </section>
  );
};
