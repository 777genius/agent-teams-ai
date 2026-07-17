import { memo } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { cn } from '@renderer/lib/utils';

interface KanbanColumnProps {
  title: string;
  count: number;
  icon?: React.ReactNode;
  headerBg?: string;
  bodyBg?: string;
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
  headerBg,
  bodyBg,
  className,
  headerClassName,
  bodyClassName,
  headerDragClassName,
  headerAccessory,
  children,
}: KanbanColumnProps): React.JSX.Element {
  return (
    <section
      className={cn('relative rounded-md', className, !bodyBg && 'bg-[var(--color-surface)]')}
      style={bodyBg ? { backgroundColor: bodyBg } : undefined}
    >
      {count > 0 && (
        <Badge
          variant="secondary"
          className="absolute -right-2 -top-2 z-10 min-w-5 px-1.5 py-0 text-[10px] font-medium leading-5"
        >
          {count}
        </Badge>
      )}
      <header
        className={cn('rounded-t-md px-3 py-2', headerClassName, headerDragClassName)}
        style={headerBg ? { backgroundColor: headerBg } : undefined}
      >
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text)]">
          {icon}
          {title}
        </h4>
        {headerAccessory && <div className="absolute right-2 top-2 z-10">{headerAccessory}</div>}
      </header>
      <div className={cn('flex max-h-[480px] flex-col gap-1.5 overflow-auto p-2', bodyClassName)}>
        {children}
      </div>
    </section>
  );
});
