import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { Columns3, LayoutGrid, Table2 } from 'lucide-react';

export type KanbanViewMode = 'grid' | 'columns' | 'table';

const OPTIONS = [
  { value: 'grid', key: 'kanban.board.gridView', icon: LayoutGrid },
  { value: 'columns', key: 'kanban.board.columnsView', icon: Columns3 },
  { value: 'table', key: 'kanban.board.tableView', icon: Table2 },
] as const;

export function KanbanViewModeSwitch({
  value,
  onChange,
}: {
  value: KanbanViewMode;
  onChange: (next: KanbanViewMode) => void;
}): React.JSX.Element {
  const { t } = useAppTranslation('team');
  return (
    <div role="group" aria-label={t('kanban.title')} className="inline-flex rounded-md border border-[var(--color-border)]">
      {OPTIONS.map((option, index) => (
        <Tooltip key={option.value}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-7 rounded-none px-2 first:rounded-l-md last:rounded-r-md',
                index > 0 && 'border-l border-[var(--color-border)]',
                value === option.value
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)]'
              )}
              onClick={() => onChange(option.value)}
              aria-label={t(option.key)}
              aria-pressed={value === option.value}
              data-testid={'kanban-view-' + option.value}
            >
              <option.icon size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t(option.key)}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
