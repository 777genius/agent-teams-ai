import { memo } from 'react';

import { cn } from '@renderer/lib/utils';

interface KanbanColumnProps {
  title: React.ReactNode;
  count: number;
  icon?: React.ReactNode;
  accentColor: string;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  headerDragClassName?: string;
  headerAccessory?: React.ReactNode;
  children: React.ReactNode;
}

export const KanbanColumn = memo(function KanbanColumn({
  title,
  count,
  icon,
  accentColor,
  className,
  headerClassName,
  bodyClassName,
  headerDragClassName,
  headerAccessory,
  children,
}: KanbanColumnProps): React.JSX.Element {
  return (
    <section
      className={cn('kanban-column-glow relative', className)}
      style={{ '--kanban-column-accent': accentColor } as React.CSSProperties}
    >
      <header
        className={cn(
          'kanban-column-header-glow relative flex items-center px-3 py-2',
          headerClassName,
          headerDragClassName
        )}
      >
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text)]">
          {icon}
          {title}
        </h4>
        <div className="ml-auto flex items-center gap-1.5 pl-2">
          {count > 0 ? (
            <span className="min-w-5 text-center text-[10px] font-medium leading-5 text-[var(--color-text-muted)]">
              {count}
            </span>
          ) : null}
          {headerAccessory}
        </div>
      </header>
      <div
        className={cn('flex max-h-[480px] flex-col gap-1.5 overflow-auto pb-2 pt-3', bodyClassName)}
      >
        {children}
      </div>
    </section>
  );
});
