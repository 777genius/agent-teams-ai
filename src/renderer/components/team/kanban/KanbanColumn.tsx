import { Badge } from '@renderer/components/ui/badge';

interface KanbanColumnProps {
  title: string;
  count: number;
  children: React.ReactNode;
}

export const KanbanColumn = ({ title, count, children }: KanbanColumnProps): React.JSX.Element => {
  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text)]">
          {title}
        </h4>
        <Badge variant="secondary" className="px-2 py-0.5 text-[10px] font-normal">
          {count}
        </Badge>
      </header>
      <div className="flex max-h-[480px] flex-col gap-2 overflow-auto p-2">{children}</div>
    </section>
  );
};
