import { useAppTranslation } from '@features/localization/renderer';
import { getThemedBadge, type TeamColorSet } from '@renderer/constants/teamColors';
import { cn } from '@renderer/lib/utils';
import {
  ChevronRight,
  Columns3,
  Expand,
  History,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Users,
} from 'lucide-react';

import { TeamSidebarHost } from './sidebar/TeamSidebarHost';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';

import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { Ref } from 'react';

const TEAM_LOADING_MEMBER_ACCENTS = ['#46d93b', '#3b82f6', '#facc15', '#14b8a6', '#ef4444'];

const TEAM_LOADING_KANBAN_COLUMNS = [
  {
    id: 'todo',
    headerBg: 'rgba(59, 130, 246, 0.28)',
    bodyBg: 'rgba(59, 130, 246, 0.06)',
  },
  {
    id: 'inProgress',
    headerBg: 'rgba(234, 179, 8, 0.28)',
    bodyBg: 'rgba(234, 179, 8, 0.07)',
  },
  {
    id: 'review',
    headerBg: 'rgba(139, 92, 246, 0.28)',
    bodyBg: 'rgba(139, 92, 246, 0.07)',
  },
] as const;

type SkeletonClassNameProps = Readonly<{ className?: string }>;

const SkeletonBlock = ({ className }: SkeletonClassNameProps): React.JSX.Element => (
  <div
    aria-hidden="true"
    className={cn('animate-pulse rounded-md bg-[var(--color-surface-raised)]', className)}
  />
);

const SkeletonPill = ({ className }: SkeletonClassNameProps): React.JSX.Element => (
  <div
    aria-hidden="true"
    className={cn('animate-pulse rounded-full bg-[var(--color-surface-raised)]', className)}
  />
);

const TeamLoadingMessageComposerSkeleton = (): React.JSX.Element => (
  <div className="relative mb-1.5 pb-1.5" aria-hidden="true">
    <div className="mb-0">
      <div className="flex items-center gap-2">
        <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded p-1 text-[var(--color-text-muted)] opacity-70">
          <Paperclip size={14} />
        </span>
        <SkeletonPill className="h-3 w-20 rounded bg-yellow-500/20" />
        <div className="ml-auto mr-[15px] inline-flex h-[26px] shrink-0 items-center overflow-hidden rounded-b-none rounded-t-[1.35rem] border border-b-0 border-[var(--color-border)] bg-[var(--color-surface-raised)]">
          <div className="flex h-full items-center gap-1.5 border-r border-r-[var(--color-border)] px-2.5">
            <SkeletonPill className="size-2 bg-[var(--skeleton-base-dim)]" />
            <SkeletonPill className="h-3 w-16 bg-[var(--skeleton-base-dim)]" />
            <SkeletonPill className="size-3 rounded bg-[var(--skeleton-base-dim)]" />
          </div>
          <div className="flex h-full items-center gap-1.5 px-2.5">
            <SkeletonPill className="h-4 w-14 bg-[var(--skeleton-base-dim)]" />
            <SkeletonPill className="size-3 rounded bg-[var(--skeleton-base-dim)]" />
          </div>
        </div>
      </div>
    </div>
    <div className="relative z-[2]">
      <div className="message-composer-shell relative h-[98px] overflow-hidden rounded-md border border-transparent bg-[var(--color-surface-raised)] shadow-[0_8px_24px_rgba(0,0,0,0.18),inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="pointer-events-none absolute inset-0 rounded-md border border-[var(--color-border-emphasis)]" />
        <SkeletonPill className="absolute left-3 top-3 h-3 w-[62%] rounded bg-[var(--skeleton-base-dim)]" />
        <SkeletonPill className="absolute left-3 top-8 h-3 w-[42%] rounded bg-[var(--skeleton-base-dim)]" />
        <SkeletonPill className="absolute bottom-2 left-2 h-5 w-[68px] border border-[var(--color-border)] bg-[var(--skeleton-base-dim)]" />
        <div className="absolute bottom-2 right-2 flex items-center gap-2">
          <SkeletonPill className="size-[26px] bg-[var(--skeleton-base-dim)]" />
          <SkeletonPill className="h-[30px] w-[72px] bg-blue-600/35" />
        </div>
      </div>
    </div>
    <div className="mt-1 flex items-start justify-between gap-2">
      <SkeletonPill className="h-3 w-56 max-w-[68%] rounded bg-[var(--skeleton-base-dim)]" />
      <SkeletonPill className="h-3 w-12 rounded bg-[var(--skeleton-base-dim)]" />
    </div>
  </div>
);

const TeamLoadingSidebarSkeleton = (): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <aside
      className="flex size-full min-h-0 flex-col overflow-hidden bg-[var(--color-surface)]"
      aria-label={t('detail.loadingSidebar')}
    >
      <div className="shrink-0 overflow-hidden px-3">
        <section className="min-w-0">
          <div className="relative -mx-3 flex min-h-9 w-[calc(100%+1.5rem)] items-stretch py-0">
            <div className="absolute inset-0 z-0 bg-[var(--color-section-bg)]" />
            <div className="relative z-10 flex min-w-0 flex-1 basis-0 flex-wrap items-center gap-2 gap-y-1 py-1 pl-4 pr-1">
              <ChevronRight
                size={14}
                className="shrink-0 text-[var(--color-text-muted)] transition-transform duration-150"
              />
              <SkeletonPill className="h-4 w-14" />
              <SkeletonPill className="h-5 w-14" />
              <span className="pointer-events-auto ml-auto inline-flex size-6 items-center justify-center rounded text-[var(--color-text-muted)] opacity-70">
                <Expand size={14} />
              </span>
              <span className="flex min-w-0 basis-full items-center gap-1.5 opacity-70">
                <MessageSquare size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                <SkeletonPill className="h-3 w-12 rounded" />
                <SkeletonPill className="h-3 w-2 rounded" />
                <SkeletonPill className="h-3 min-w-0 flex-1 rounded" />
              </span>
            </div>
          </div>
        </section>
      </div>
      <div className="bg-[var(--color-text-muted)]/35 h-px shrink-0" />
      <div className="min-h-0 flex-1">
        <div className="flex size-full flex-col overflow-hidden bg-[var(--color-surface-sidebar)]">
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-sidebar)] px-3 py-2">
            <MessageSquare size={14} className="shrink-0 text-[var(--color-text-muted)]" />
            <SkeletonPill className="h-4 w-24" />
            <SkeletonPill className="h-5 w-8" />
            <span className="ml-auto inline-flex size-7 items-center justify-center rounded text-[var(--color-text-muted)] opacity-70">
              <MoreHorizontal size={15} />
            </span>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden pb-14 pr-3 pt-2">
            <div className="pl-3">
              <TeamLoadingMessageComposerSkeleton />
            </div>
            <div className="space-y-3 overflow-hidden pl-3">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-sidebar)] p-3"
                >
                  <div className="flex items-center gap-2">
                    <SkeletonPill className="h-5 w-12" />
                    <SkeletonPill className="h-3 w-16" />
                    <SkeletonPill className="ml-auto h-3 w-12" />
                  </div>
                  <SkeletonPill className="mt-5 h-4 w-[88%]" />
                  <SkeletonPill className="mt-2 h-4 w-[72%]" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};

type TeamLoadingSectionHeaderProps = Readonly<{
  icon: React.ReactNode;
  titleWidth: string;
  badgeWidth?: string;
  actionWidth?: string;
  open?: boolean;
}>;

const TeamLoadingSectionHeader = ({
  icon,
  titleWidth,
  badgeWidth,
  actionWidth,
  open = true,
}: TeamLoadingSectionHeaderProps): React.JSX.Element => (
  <div
    className="relative flex min-h-9 items-stretch py-1.5"
    style={{
      marginInline: 'calc((1rem - 5px) * -1)',
      width: 'calc(100% + 2rem - 10px)',
    }}
  >
    <div
      className={cn(
        'absolute inset-0 z-0',
        open
          ? 'rounded-t-xl bg-[var(--color-section-bg-open)]'
          : 'rounded-xl bg-[var(--color-section-bg)]'
      )}
    />
    <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2 pl-4">
      <ChevronRight
        size={14}
        className={cn(
          'shrink-0 text-[var(--color-text-muted)] transition-transform duration-150',
          open && 'rotate-90'
        )}
      />
      <span className="shrink-0 text-[var(--color-text-muted)]">{icon}</span>
      <SkeletonPill className={cn('h-4', titleWidth)} />
      {badgeWidth ? <SkeletonPill className={cn('h-5', badgeWidth)} /> : null}
    </div>
    {actionWidth ? (
      <div className="relative z-10 flex shrink-0 items-center pr-3">
        <SkeletonPill className={cn('h-5', actionWidth)} />
      </div>
    ) : null}
  </div>
);

type TeamContentLoadingSkeletonProps = Readonly<{
  teamName: string;
  headerColorSet: TeamColorSet;
  isLight: boolean;
  contentRef?: Ref<HTMLDivElement>;
  provisioningBannerRef?: Ref<HTMLDivElement>;
}>;

const TeamContentLoadingSkeleton = ({
  teamName,
  headerColorSet,
  isLight,
  contentRef,
  provisioningBannerRef,
}: TeamContentLoadingSkeletonProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  return (
    <div
      ref={contentRef}
      className="size-full min-w-0 overflow-y-auto overflow-x-hidden p-4"
      data-team-name={teamName}
      role="status"
      aria-label={t('detail.loading')}
    >
      <div className="relative -mx-4 -mt-4 mb-3 overflow-hidden border-b border-[var(--color-border)] px-4 py-3">
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{ backgroundColor: getThemedBadge(headerColorSet, isLight) }}
        />
        <div className="relative z-10 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex h-6 items-center gap-2">
              <SkeletonPill className="h-5 w-44" />
              <SkeletonPill className="h-5 w-20 bg-emerald-500/15" />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <SkeletonPill className="h-7 w-16" />
            <SkeletonPill className="size-7 rounded" />
            <SkeletonPill className="size-7 rounded" />
          </div>
        </div>
        <SkeletonPill className="relative z-10 mt-0.5 h-3 w-72 max-w-full" />
        <div className="relative z-10 mt-1 flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
            <SkeletonPill className="h-3 w-28" />
            <SkeletonPill className="h-5 w-24 rounded-md" />
            <SkeletonPill className="h-3 w-16" />
          </div>
          <SkeletonPill className="-mt-2 h-8 w-24 shrink-0 rounded-full border border-cyan-300/25 bg-cyan-500/10" />
        </div>
      </div>

      <div ref={provisioningBannerRef}>
        <TeamProvisioningBanner teamName={teamName} />
      </div>

      <section className="min-w-0 [&:not(:last-child)]:mb-[10px]">
        <TeamLoadingSectionHeader
          icon={<Users size={14} />}
          titleWidth="w-20"
          badgeWidth="w-8"
          actionWidth="w-20"
        />
        <div className="mt-3 grid grid-cols-1 gap-1 pb-4">
          {TEAM_LOADING_MEMBER_ACCENTS.map((accent, index) => (
            <div key={accent} className="flex min-h-[52px] min-w-0 items-center gap-2.5">
              <div className="relative size-[34px] shrink-0">
                <div
                  className="absolute inset-0 rounded-full border-2 bg-[var(--color-surface-raised)]"
                  style={{
                    borderColor: accent,
                    boxShadow: isLight ? 'none' : `0 0 0 1px ${accent}26`,
                  }}
                />
                <div
                  className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[var(--color-surface)]"
                  style={{ backgroundColor: accent }}
                />
              </div>
              <div className="min-w-0 flex-1">
                <SkeletonPill
                  className={cn('h-4', index === 0 ? 'w-14' : index === 3 ? 'w-16' : 'w-12')}
                />
                <SkeletonPill
                  className={cn(
                    'mt-1.5 h-2.5',
                    index === 1 ? 'w-60' : index === 4 ? 'w-64' : 'w-52'
                  )}
                />
              </div>
              <div className="hidden shrink-0 items-center gap-3 sm:flex">
                <SkeletonPill className="h-[18px] w-[62px]" />
                <SkeletonPill className="h-[18px] w-[62px]" />
                <SkeletonPill className="size-[21px] rounded" />
                <SkeletonPill className="size-[21px] rounded" />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="min-w-0 [&:not(:last-child)]:mb-[10px]">
        <TeamLoadingSectionHeader icon={<History size={14} />} titleWidth="w-24" open={false} />
      </section>

      <section className="min-w-0 [&:not(:last-child)]:mb-[10px]">
        <TeamLoadingSectionHeader
          icon={<Columns3 size={14} />}
          titleWidth="w-24"
          badgeWidth="w-8"
          actionWidth="w-16"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="relative h-9 min-w-[220px] max-w-sm flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-sidebar)]">
            <SkeletonPill className="absolute left-3 top-1/2 size-4 -translate-y-1/2 rounded" />
            <SkeletonPill className="absolute left-10 top-1/2 h-4 w-44 -translate-y-1/2" />
          </div>
          <div className="flex items-center gap-2">
            <SkeletonBlock className="h-9 w-20" />
            <SkeletonBlock className="h-9 w-28" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-12 gap-3">
          {TEAM_LOADING_KANBAN_COLUMNS.map((column) => (
            <div
              key={column.id}
              className="col-span-4 flex h-[400px] min-h-0 flex-col overflow-hidden rounded-md border border-[var(--color-border)]"
              style={{ backgroundColor: column.bodyBg }}
            >
              <div
                className="flex shrink-0 items-center gap-2 px-3 py-2"
                style={{ backgroundColor: column.headerBg }}
              >
                <SkeletonPill className="size-4 rounded" />
                <SkeletonPill className={cn('h-4', column.id === 'inProgress' ? 'w-32' : 'w-20')} />
              </div>
              <div className="min-h-0 flex-1 overflow-hidden p-2">
                <div
                  className="flex h-12 items-center justify-center rounded-md border border-dashed border-[var(--color-border)]"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--color-surface) 35%, transparent)',
                  }}
                >
                  <SkeletonPill className="h-4 w-28" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export type TeamLoadingSkeletonProps = Readonly<{
  teamName: string;
  isActive?: boolean;
  isFocused?: boolean;
  messagesPanelMode: TeamMessagesPanelMode;
  headerColorSet: TeamColorSet;
  isLight: boolean;
  contentRef?: Ref<HTMLDivElement>;
  provisioningBannerRef?: Ref<HTMLDivElement>;
}>;

export const TeamLoadingSkeleton = ({
  teamName,
  isActive,
  isFocused,
  messagesPanelMode,
  headerColorSet,
  isLight,
  contentRef,
  provisioningBannerRef,
}: TeamLoadingSkeletonProps): React.JSX.Element => (
  <div className="flex size-full overflow-hidden">
    {messagesPanelMode === 'sidebar' ? (
      <TeamSidebarHost
        teamName={teamName}
        surface="team"
        isActive={Boolean(isActive)}
        isFocused={Boolean(isFocused)}
      >
        <TeamLoadingSidebarSkeleton />
      </TeamSidebarHost>
    ) : null}
    <div className="relative min-h-0 min-w-0 flex-1">
      <TeamContentLoadingSkeleton
        teamName={teamName}
        headerColorSet={headerColorSet}
        isLight={isLight}
        contentRef={contentRef}
        provisioningBannerRef={provisioningBannerRef}
      />
    </div>
  </div>
);
