import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { cn } from '@renderer/lib/utils';
import { ChevronRight } from 'lucide-react';

function scrollAfterExpand(el: HTMLElement): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

interface CollapsibleTeamSectionProps {
  title: string;
  /** Icon rendered before the title text. */
  icon?: React.ReactNode;
  badge?: string | number;
  /** Secondary badge (e.g. unread count). Shown next to main badge when defined. */
  secondaryBadge?: number;
  /** Element rendered immediately after secondary badge (e.g. mark-all-read button). */
  afterBadge?: React.ReactNode;
  /** Extra element rendered inline after badges (e.g. notification icon). */
  headerExtra?: React.ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  action?: React.ReactNode;
  /** Stable identifier used for programmatic section navigation. */
  sectionId?: string;
  /** Extra classes applied to the content wrapper (e.g. padding). */
  contentClassName?: string;
  /** Extra classes for the header bar (e.g. "-mx-6 w-[calc(100%+3rem)]" to match parent padding). */
  headerClassName?: string;
  /** Extra classes for the inner header content (e.g. "pl-6" to match parent padding). */
  headerContentClassName?: string;
  /** When true, children stay mounted (hidden via CSS) when collapsed. Useful when children drive header state (e.g. online indicators). */
  keepMounted?: boolean;
  children: React.ReactNode;
}

export const CollapsibleTeamSection = ({
  title,
  icon,
  badge,
  secondaryBadge,
  afterBadge,
  headerExtra,
  defaultOpen = true,
  forceOpen,
  onOpenChange,
  action,
  sectionId,
  contentClassName,
  headerClassName,
  headerContentClassName,
  keepMounted,
  children,
}: CollapsibleTeamSectionProps): React.JSX.Element => {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = forceOpen ? true : open;
  const sectionRef = useRef<HTMLElement>(null);

  const handleNavigate = useCallback((): void => {
    setOpen(true);
    if (sectionRef.current) scrollAfterExpand(sectionRef.current);
  }, []);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    el.addEventListener('team-section-navigate', handleNavigate);
    return () => el.removeEventListener('team-section-navigate', handleNavigate);
  }, [handleNavigate]);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  return (
    <section ref={sectionRef} data-section-id={sectionId} className="min-w-0">
      <div
        className={cn(
          'relative -mx-[calc(1rem-5px)] flex min-h-9 w-[calc(100%+2rem-10px)] items-stretch py-1.5',
          headerClassName
        )}
      >
        <button
          type="button"
          className={`absolute inset-0 z-0 cursor-pointer transition-colors ${isOpen ? 'rounded-t-xl bg-[var(--color-section-bg-open)] hover:bg-[var(--color-section-hover-open)]' : 'rounded-xl bg-[var(--color-section-bg)] hover:bg-[var(--color-section-hover)]'}`}
          onClick={() =>
            setOpen((prev) => {
              const next = !prev;
              if (next && sectionRef.current) {
                scrollAfterExpand(sectionRef.current);
              }
              return next;
            })
          }
          aria-label={isOpen ? 'Collapse section' : 'Expand section'}
        />
        <div
          className={cn(
            'pointer-events-none relative z-10 flex min-w-0 flex-1 basis-0 items-center gap-2 pl-4',
            headerContentClassName
          )}
        >
          <ChevronRight
            size={14}
            className={`shrink-0 text-[var(--color-text-muted)] transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
          />
          {icon ? <span className="shrink-0 text-[var(--color-text-muted)]">{icon}</span> : null}
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
              className="bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-normal leading-none text-blue-600 dark:text-blue-400"
              title={`${secondaryBadge} unread`}
            >
              {secondaryBadge} new
            </Badge>
          )}
          {afterBadge}
          {headerExtra}
        </div>
        {action && (
          <div className="relative z-10 flex shrink-0 items-center self-start">{action}</div>
        )}
      </div>
      {keepMounted ? (
        <div
          className={cn('mt-1.5 min-w-0 overflow-x-clip pb-2', contentClassName)}
          style={isOpen ? undefined : { display: 'none' }}
        >
          {children}
        </div>
      ) : (
        isOpen && (
          <div className={cn('mt-1.5 min-w-0 overflow-x-clip pb-2', contentClassName)}>
            {children}
          </div>
        )
      )}
    </section>
  );
};
