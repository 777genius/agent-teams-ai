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
  headerAccessory?: React.ReactNode;
  children: React.ReactNode;
}

export const KanbanColumn = ({
  title,
  count,
  icon,
  headerBg,
  bodyBg,
  className,
  headerClassName,
  bodyClassName,
  headerAccessory,
  children,
}: KanbanColumnProps): React.JSX.Element => {
  return (
    <section
      className={cn(
        'relative rounded-md border border-[var(--color-border)]',
        className,
        !bodyBg && 'bg-[var(--color-surface)]'
      )}
      style={bodyBg ? { backgroundColor: bodyBg } : undefined}
    >
      <header
        className={cn('border-b border-[var(--color-border)] px-3 py-2 pr-14', headerClassName)}
        style={headerBg ? { backgroundColor: headerBg } : undefined}
      >
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text)]">
          {icon}
          {title}
        </h4>
        <div className="absolute right-2 top-2 z-10 flex items-center gap-2">
          {headerAccessory}
          <Badge variant="secondary" className="px-2 py-0.5 text-[10px] font-normal">
            {count}
          </Badge>
        </div>
      </header>
      <div className={cn('flex max-h-[480px] flex-col overflow-auto p-2', bodyClassName)}>
        {children}
      </div>
    </section>
  );
};
