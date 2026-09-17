import { useAppTranslation } from '@features/localization/renderer';
import { getThemedBorder, type TeamColorSet } from '@renderer/constants/teamColors';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import {
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Columns3,
  Expand,
  Eye,
  History,
  MessageSquare,
  PlayCircle,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { KANBAN_COLUMN_CONTROL_INSET_CLASS, KanbanColumn } from './kanban/KanbanColumn';
import { KanbanTaskCardSkeleton } from './kanban/KanbanTaskCardSkeleton';
import { MessagesConversationSkeleton } from './messages/MessagesConversationSkeleton';
import { conversationDisplayTitle } from './messages/messagesPanelConversations';
import { TeamSidebarHost } from './sidebar/TeamSidebarHost';
import { getTeamMessagesSidebarUiState } from './sidebar/teamSidebarUiState';
import {
  getTeamLoadingMemberSkeletonCount,
  teamLoadingMemberSkeletonAccents,
} from './teamLoadingMemberSkeleton';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';

import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { Ref } from 'react';

const TEAM_LOADING_KANBAN_COLUMNS = [
  {
    id: 'todo',
    accentColor: 'rgb(59, 130, 246)',
    icon: ClipboardList,
    titleWidth: 'w-16',
    gridColumn: '1 / span 4',
    gridRow: '1 / span 14',
    cardHeights: [96, 116],
    showAddButton: true,
  },
  {
    id: 'inProgress',
    accentColor: 'rgb(234, 179, 8)',
    icon: PlayCircle,
    titleWidth: 'w-28',
    gridColumn: '5 / span 4',
    gridRow: '1 / span 14',
    cardHeights: [96, 96],
    showAddButton: true,
  },
  {
    id: 'review',
    accentColor: 'rgb(139, 92, 246)',
    icon: Eye,
    titleWidth: 'w-16',
    gridColumn: '9 / span 4',
    gridRow: '1 / span 14',
    cardHeights: [116],
    showAddButton: false,
  },
  {
    id: 'done',
    accentColor: 'rgb(20, 184, 166)',
    icon: CheckCircle2,
    titleWidth: 'w-14',
    gridColumn: '1 / span 6',
    gridRow: '15 / span 14',
    cardHeights: [96, 96],
    showAddButton: false,
  },
  {
    id: 'approved',
    accentColor: 'rgb(101, 163, 13)',
    icon: ShieldCheck,
    titleWidth: 'w-20',
    gridColumn: '7 / span 6',
    gridRow: '15 / span 14',
    cardHeights: [116],
    showAddButton: false,
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

const TeamLoadingOfflineBannerSkeleton = (): React.JSX.Element => (
  <div
    aria-hidden="true"
    className="relative mb-2.5 flex min-h-11 items-center gap-2.5 overflow-hidden rounded-md border border-amber-500/20 bg-amber-500/[0.055] py-2 pl-3 pr-2.5"
  >
    <SkeletonBlock className="size-7 shrink-0 border border-amber-500/15 bg-amber-500/10" />
    <SkeletonPill className="h-3.5 w-28 bg-amber-500/10" />
    <SkeletonBlock className="ml-auto h-7 w-20 shrink-0 border border-emerald-500/15 bg-emerald-500/10" />
  </div>
);

const TeamLoadingSidebarSkeleton = ({
  teamName,
  memberCount,
}: {
  teamName: string;
  memberCount: number;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const ui = getTeamMessagesSidebarUiState(teamName);
  const surface = ui.conversationSurface ?? 'list';
  const scope = ui.conversationScope ?? { kind: 'team-feed' };
  const title = conversationDisplayTitle(surface, scope, {
    list: t('messages.title'),
    teamFeed: t('messages.chats.teamFeed'),
  });

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
        <MessagesConversationSkeleton
          surface={surface}
          scope={scope}
          title={title}
          memberCount={memberCount}
        />
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
    className="relative flex min-h-10 items-stretch border-b border-[var(--color-border)]"
    style={{
      marginInline: 'calc((1rem - 5px) * -1)',
      width: 'calc(100% + 2rem - 10px)',
    }}
  >
    <div
      className={cn(
        'absolute inset-0 z-0',
        open ? 'rounded-t-md bg-[var(--color-section-bg)]' : 'rounded-md bg-transparent'
      )}
    />
    <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2 pl-2.5">
      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]">
        {icon}
      </span>
      <SkeletonPill className={cn('h-4', titleWidth)} />
      {badgeWidth ? (
        <SkeletonPill className={cn('h-5 border border-[var(--color-border)]', badgeWidth)} />
      ) : null}
    </div>
    {actionWidth ? (
      <div className="relative z-10 flex shrink-0 items-center pr-3">
        <SkeletonPill className={cn('h-5', actionWidth)} />
      </div>
    ) : null}
    <span className="relative z-10 flex shrink-0 items-center px-2.5">
      <ChevronRight
        size={14}
        className={cn(
          'text-[var(--color-text-muted)] transition-transform duration-150',
          open && 'rotate-90'
        )}
      />
    </span>
  </div>
);

type TeamContentLoadingSkeletonProps = Readonly<{
  teamName: string;
  memberCount: number;
  headerColorSet: TeamColorSet;
  isLight: boolean;
  showOfflineBanner?: boolean;
  contentRef?: Ref<HTMLDivElement>;
  provisioningBannerRef?: Ref<HTMLDivElement>;
}>;

const TeamContentLoadingSkeleton = ({
  teamName,
  memberCount,
  headerColorSet,
  isLight,
  showOfflineBanner = false,
  contentRef,
  provisioningBannerRef,
}: TeamContentLoadingSkeletonProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const memberAccents = teamLoadingMemberSkeletonAccents(memberCount);

  return (
    <div
      ref={contentRef}
      className="size-full min-w-0 overflow-y-auto overflow-x-hidden p-4 [&>section:last-of-type>div:first-child]:border-b-0"
      data-team-name={teamName}
      role="status"
      aria-label={t('detail.loading')}
    >
      <div className="relative -mx-4 -mt-4 mb-3 overflow-hidden border-b border-[var(--color-border-emphasis)] bg-[var(--color-surface)] px-4 py-3.5">
        <div
          className="pointer-events-none absolute inset-y-3 left-0 w-0.5 rounded-r-full"
          style={{ backgroundColor: getThemedBorder(headerColorSet, isLight) }}
        />
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex h-6 items-center gap-2">
              <SkeletonPill className="h-5 w-44" />
              <SkeletonPill className="h-5 w-20 bg-emerald-500/15" />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <SkeletonPill className="h-7 w-16" />
            <SkeletonPill className="size-7 rounded-full" />
            <SkeletonPill className="size-7 rounded-full" />
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
            <SkeletonPill className="h-3 w-32" />
            <SkeletonPill className="h-3 w-16" />
            <SkeletonPill className="h-3 w-36" />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <SkeletonPill className="h-8 w-20 rounded-md" />
            <SkeletonPill className="h-8 w-16 rounded-md" />
            <SkeletonPill className="h-8 w-24 rounded-md" />
          </div>
        </div>
      </div>

      {showOfflineBanner ? <TeamLoadingOfflineBannerSkeleton /> : null}

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
        <div
          className="mt-3 grid grid-cols-1 gap-1 pb-4"
          data-team-loading-member-count={memberCount}
        >
          {memberAccents.map((accent, index) => (
            <div
              key={`${accent}-${index}`}
              className="flex min-h-[52px] min-w-0 items-center gap-2.5"
              data-team-loading-member-row="true"
            >
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
        <div className="-mx-4 w-[calc(100%+2rem)]">
          <div className="mt-3 flex min-w-0 max-w-full items-center gap-2 px-2">
            <div className="relative h-8 min-w-0 max-w-full flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] sm:max-w-[33.333333%]">
              <SkeletonPill className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 rounded" />
              <SkeletonPill className="absolute left-8 top-1/2 h-3 w-[58%] -translate-y-1/2 rounded" />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <SkeletonBlock className="h-7 w-[62px]" />
              <SkeletonBlock className="h-7 w-[66px]" />
            </div>
          </div>
          <div className="mt-2 grid grid-cols-12 gap-y-3" style={{ gridAutoRows: '18px' }}>
            {TEAM_LOADING_KANBAN_COLUMNS.map((column) => (
              <div
                key={column.id}
                className="min-h-0"
                style={{ gridColumn: column.gridColumn, gridRow: column.gridRow }}
              >
                <KanbanColumn
                  title={<SkeletonPill className={cn('h-3', column.titleWidth)} />}
                  count={0}
                  icon={
                    <column.icon
                      size={14}
                      className="shrink-0 text-[var(--kanban-column-accent)]"
                    />
                  }
                  accentColor={column.accentColor}
                  headerAccessory={
                    <SkeletonPill className="h-2.5 w-3 rounded bg-[var(--skeleton-base-dim)]" />
                  }
                  className="flex h-full min-h-0 animate-pulse flex-col"
                  headerClassName="shrink-0"
                  bodyClassName="min-h-0 max-h-none flex-1 overflow-hidden"
                >
                  {column.cardHeights.map((height, index) => (
                    <KanbanTaskCardSkeleton
                      key={`${column.id}:${height}:${index}`}
                      height={height}
                      showSeparator={index < column.cardHeights.length - 1}
                    />
                  ))}
                  {column.showAddButton ? (
                    <div
                      className={cn(
                        KANBAN_COLUMN_CONTROL_INSET_CLASS,
                        'flex shrink-0 items-center justify-center rounded-md border border-dashed border-[var(--color-border)] p-3'
                      )}
                    >
                      <SkeletonPill className="h-4 w-28" />
                    </div>
                  ) : null}
                </KanbanColumn>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
};

export type TeamLoadingSkeletonProps = Readonly<{
  teamName: string;
  isActive?: boolean;
  isFocused?: boolean;
  showOfflineBanner?: boolean;
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
  showOfflineBanner = false,
  messagesPanelMode,
  headerColorSet,
  isLight,
  contentRef,
  provisioningBannerRef,
}: TeamLoadingSkeletonProps): React.JSX.Element => {
  const memberCount = useStore((state) =>
    getTeamLoadingMemberSkeletonCount(state.teamByName[teamName])
  );

  return (
    <div className="flex size-full overflow-hidden">
      {messagesPanelMode === 'sidebar' ? (
        <TeamSidebarHost
          teamName={teamName}
          surface="team"
          isActive={Boolean(isActive)}
          isFocused={Boolean(isFocused)}
          reserveSpaceWithoutSource
        >
          <TeamLoadingSidebarSkeleton teamName={teamName} memberCount={memberCount} />
        </TeamSidebarHost>
      ) : null}
      <div className="relative min-h-0 min-w-0 flex-1">
        <TeamContentLoadingSkeleton
          teamName={teamName}
          memberCount={memberCount}
          headerColorSet={headerColorSet}
          isLight={isLight}
          showOfflineBanner={showOfflineBanner}
          contentRef={contentRef}
          provisioningBannerRef={provisioningBannerRef}
        />
      </div>
    </div>
  );
};
