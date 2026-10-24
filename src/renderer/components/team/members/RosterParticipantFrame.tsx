import { cn } from '@renderer/lib/utils';

import { FLAT_ROSTER_GRID_COLUMNS } from './flatRosterLayout';

import type { ReactNode } from 'react';

interface FrameProps {
  children: ReactNode;
  accentColor: string;
  isLight: boolean;
  layout: 'flat' | 'lead' | 'member';
  dataRole: string;
  removed?: boolean;
}

/** Shared display shell; it does not own roster editing, runtime discovery or state. */
export const RosterParticipantFrame = ({
  children,
  accentColor,
  isLight,
  layout,
  dataRole,
  removed = false,
}: Readonly<FrameProps>): React.JSX.Element => {
  const flat = layout === 'flat';
  return (
    <div
      className={cn(
        'relative grid grid-cols-1 gap-2 md:items-start',
        flat
          ? cn(
              'hover:bg-[var(--color-surface-raised)]/45 rounded-sm px-4 py-2 transition-colors',
              FLAT_ROSTER_GRID_COLUMNS
            )
          : cn(
              'rounded-md p-2 shadow-sm',
              layout === 'lead'
                ? 'md:grid-cols-[minmax(220px,1fr)_minmax(230px,1fr)_190px]'
                : 'md:grid-cols-[minmax(0,1fr)_156px_auto]'
            ),
        removed && 'opacity-55'
      )}
      data-role={dataRole}
      style={{
        backgroundColor: flat
          ? undefined
          : isLight
            ? 'color-mix(in srgb, var(--color-surface-raised) 22%, white 78%)'
            : 'var(--color-surface-raised)',
        boxShadow: flat
          ? undefined
          : isLight
            ? '0 1px 2px rgba(15, 23, 42, 0.06)'
            : '0 1px 2px rgba(0, 0, 0, 0.28)',
      }}
    >
      <div
        className={cn('absolute inset-y-0 left-0 w-1', flat ? 'my-2 rounded-full' : 'rounded-l-md')}
        style={{ backgroundColor: accentColor }}
        aria-hidden="true"
      />
      {children}
    </div>
  );
};

export const RosterParticipantIdentity = ({
  avatarSrc,
  children,
}: Readonly<{
  avatarSrc?: string;
  children: ReactNode;
}>): React.JSX.Element => {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt=""
          className="size-8 shrink-0 rounded-full bg-[var(--color-surface-raised)]"
          loading="lazy"
        />
      ) : null}
      {children}
    </div>
  );
};
