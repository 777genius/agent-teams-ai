import { useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { ChevronRight } from 'lucide-react';

interface CollapsibleTeamSectionProps {
  title: string;
  badge?: string | number;
  /** Secondary badge (e.g. unread count). Shown next to main badge when defined. */
  secondaryBadge?: number;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}

export const CollapsibleTeamSection = ({
  title,
  badge,
  secondaryBadge,
  defaultOpen = true,
  forceOpen,
  action,
  children,
}: CollapsibleTeamSectionProps): React.JSX.Element => {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen ? true : open;

  return (
    <section className="border-b border-[var(--color-border)] pb-3 last:border-b-0">
      <div className="relative -mx-4 flex min-h-10 w-full items-stretch py-3">
        <button
          type="button"
          className="absolute inset-0 z-0 cursor-pointer rounded-md transition-colors hover:bg-[var(--color-surface-raised)]"
          onClick={() => setOpen((prev) => !prev)}
          aria-label={isOpen ? 'Collapse section' : 'Expand section'}
        />
        <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 basis-0 items-center gap-2 pl-4">
          <ChevronRight
            size={14}
            className={`shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
          />
          <span className="text-sm font-medium text-[var(--color-text)]">{title}</span>
          {badge != null && (
            <Badge
              variant="secondary"
              className="px-1.5 py-0.5 text-[10px] font-normal leading-none"
            >
              {badge}
            </Badge>
          )}
          {secondaryBadge != null && secondaryBadge > 0 && (
            <Badge
              variant="secondary"
              className="bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-normal leading-none text-blue-400"
              title={`${secondaryBadge} unread`}
            >
              {secondaryBadge} new
            </Badge>
          )}
        </div>
        {action && <div className="relative z-10 flex shrink-0 items-center">{action}</div>}
      </div>
      {isOpen && <div className="mt-2">{children}</div>}
    </section>
  );
};
