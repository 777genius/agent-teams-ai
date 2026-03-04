import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
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
  /** Extra element rendered inline after badges (e.g. notification icon). */
  headerExtra?: React.ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  action?: React.ReactNode;
  /** Stable identifier used for programmatic section navigation. */
  sectionId?: string;
  children: React.ReactNode;
}

export const CollapsibleTeamSection = ({
  title,
  icon,
  badge,
  secondaryBadge,
  headerExtra,
  defaultOpen = true,
  forceOpen,
  action,
  sectionId,
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

  return (
    <section ref={sectionRef} data-section-id={sectionId} className="min-w-0">
      <div className="relative -mx-4 flex min-h-9 w-[calc(100%+2rem)] items-stretch py-1.5">
        <button
          type="button"
          className={`absolute inset-0 z-0 cursor-pointer transition-colors ${isOpen ? 'rounded-t-md bg-white/[0.07] hover:bg-white/[0.1]' : 'rounded-md bg-white/[0.04] hover:bg-white/[0.08]'}`}
          onClick={() => setOpen((prev) => !prev)}
          aria-label={isOpen ? 'Collapse section' : 'Expand section'}
        />
        <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 basis-0 items-center gap-2 pl-4">
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
              className="bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-normal leading-none text-blue-400"
              title={`${secondaryBadge} unread`}
            >
              {secondaryBadge} new
            </Badge>
          )}
          {headerExtra}
        </div>
        {action && <div className="relative z-10 flex shrink-0 items-center">{action}</div>}
      </div>
      {isOpen && <div className="mt-1.5 min-w-0 overflow-x-hidden pb-2 pl-2.5">{children}</div>}
    </section>
  );
};
