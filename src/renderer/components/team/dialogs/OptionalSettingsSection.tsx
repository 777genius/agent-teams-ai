import React, { useMemo, useState } from 'react';

import { cn } from '@renderer/lib/utils';
import { ChevronRight, Settings2 } from 'lucide-react';

interface OptionalSettingsSectionProps {
  title: string;
  description: string;
  summary?: string[];
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const OptionalSettingsSection = ({
  title,
  description,
  summary = [],
  defaultOpen = false,
  className,
  children,
}: OptionalSettingsSectionProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const visibleSummary = useMemo(
    () =>
      summary
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 4),
    [summary]
  );

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-[var(--color-border-emphasis)] shadow-sm',
        className
      )}
      style={{
        backgroundColor: 'color-mix(in srgb, var(--color-surface-overlay) 94%, white 6%)',
      }}
    >
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--color-surface-raised)]"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 rounded-md border border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] p-1.5 text-[var(--color-text-muted)]">
            <Settings2 className="size-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-[var(--color-text)]">{title}</span>
              <span className="rounded-full border border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                Optional
              </span>
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{description}</p>
            {!isOpen ? (
              <p className="mt-1.5 line-clamp-2 text-[11px] text-[var(--color-text-secondary)]">
                {visibleSummary.length > 0
                  ? visibleSummary.join(' • ')
                  : 'Collapsed by default to keep the primary flow focused.'}
              </p>
            ) : null}
          </div>
        </div>
        <ChevronRight
          className={cn(
            'mt-0.5 size-4 shrink-0 text-[var(--color-text-muted)] transition-transform duration-150',
            isOpen && 'rotate-90'
          )}
        />
      </button>

      {isOpen ? (
        <div
          className="border-t border-[var(--color-border-emphasis)] px-3 pb-3 pt-2.5"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--color-surface-overlay) 86%, white 14%)',
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
};
