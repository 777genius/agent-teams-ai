import { useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import { useRecentProjectsSection } from '../hooks/useRecentProjectsSection';

import { RecentProjectsSectionView } from './RecentProjectsSectionView';

import type { RecentProjectsCollectionSource } from '../hooks/useRecentProjectsCollection';
import type { RecentProjectCardModel as DesktopCardModel } from '../view-models/recentProjectsSectionViewModel';
import type {
  ActionState,
  RecentProjectCardModel,
  RecentProjectIdentity,
} from './recentProjectsModel';

interface RecentProjectsSectionProps {
  searchQuery: string;
}

function toSharedCard(
  card: DesktopCardModel,
  identity: RecentProjectIdentity,
  tasksKnown: boolean,
  aliveTeamsKnown: boolean,
  degraded: boolean,
  stale: boolean
): RecentProjectCardModel {
  const available = card.filesystemState !== 'deleted';
  const paths = [card.project.primaryPath, ...card.project.associatedPaths];
  const action: ActionState = available
    ? { support: 'supported', availability: 'available' }
    : {
        support: 'supported',
        availability: 'unavailable',
        reason: 'Project folder is missing.',
        cause: 'deleted',
      };
  return {
    identity,
    name: card.name,
    subtitle: card.formattedPath,
    activity:
      Number.isFinite(card.project.mostRecentActivity) && card.project.mostRecentActivity >= 0
        ? {
            kind: 'known',
            value: {
              label: card.lastActivityLabel,
              observedAt: card.project.mostRecentActivity,
              freshness: stale ? ('stale' as const) : ('fresh' as const),
            },
          }
        : { kind: 'unknown', reason: 'read_failed' },
    providers:
      card.providerIds.length > 0
        ? {
            kind: 'known',
            value: card.providerIds.map((id) => ({
              id,
              freshness: stale ? ('stale' as const) : ('fresh' as const),
            })),
          }
        : { kind: 'unknown', reason: degraded ? 'partial' : 'not_provided' },
    branch: card.primaryBranch
      ? { kind: 'known', value: card.primaryBranch }
      : { kind: 'unknown', reason: 'not_provided' },
    taskCounts: tasksKnown
      ? { kind: 'known', value: card.taskCounts ?? { pending: 0, inProgress: 0, completed: 0 } }
      : { kind: 'unknown', reason: 'partial' },
    tasksLoading: card.tasksLoading,
    activeTeams:
      Boolean(card.activeTeams?.length) || aliveTeamsKnown
        ? {
            kind: 'known',
            value: (card.activeTeams ?? []).map((team) => ({
              targetKey: team.teamName,
              displayName: team.displayName,
            })),
          }
        : { kind: 'unknown', reason: 'partial' },
    open: action,
    reveal: action,
    desktopPathDetails: [...new Set(paths)].map((text, index) => ({
      label: index === 0 ? 'Primary path' : `Related path ${index}`,
      text,
    })),
    pathBadge: card.pathSummary
      ? { label: card.pathSummary.badgeLabel, description: card.pathSummary.description }
      : undefined,
  };
}

/** Desktop connector: rich project DTOs and native effects stop at this boundary. */
export const RecentProjectsSection = ({
  searchQuery,
}: Readonly<RecentProjectsSectionProps>): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const desktop = useRecentProjectsSection();
  const keysRef = useRef(new Map<string, string>());
  const nextKeyRef = useRef(0);
  const projectsRef = useRef(new Map<string, DesktopCardModel>());
  const projects = new Map<string, DesktopCardModel>();
  const rows = desktop.cards.map((card) => {
    let key = keysRef.current.get(card.id);
    if (!key) {
      key = `recent-${++nextKeyRef.current}`;
      keysRef.current.set(card.id, key);
    }
    projects.set(key, card);
    return toSharedCard(
      card,
      { scopeKey: desktop.scopeKey, targetKey: key, readEpoch: desktop.readEpoch },
      desktop.tasksKnown,
      desktop.aliveTeamsKnown,
      desktop.degraded,
      desktop.stale
    );
  });
  projectsRef.current = projects;

  const resolve = (intent: RecentProjectIdentity): DesktopCardModel | null => {
    if (intent.scopeKey !== desktop.scopeKey || !desktop.isCurrentIntent(intent)) return null;
    const card = projectsRef.current.get(intent.targetKey);
    return card?.filesystemState === 'deleted' ? null : (card ?? null);
  };
  const source: RecentProjectsCollectionSource = {
    scopeKey: desktop.scopeKey,
    readEpoch: desktop.readEpoch,
    rows,
    completeness: desktop.degraded ? 'partial' : 'complete',
    stale: desktop.stale,
    openProject: async (intent) => {
      const card = resolve(intent);
      return card ? desktop.openRecentProject(card.project) : { kind: 'stale_target' as const };
    },
    revealProject: async (intent) => {
      const card = resolve(intent);
      return card
        ? desktop.openProjectPath(card.project.primaryPath)
        : { kind: 'stale_target' as const };
    },
    extensionAction: desktop.isElectron
      ? {
          label: t('recentProjects.selectFolder'),
          ariaLabel: t('recentProjects.selectFolderTitle'),
          icon: 'folder',
          run: desktop.selectProjectFolder,
        }
      : undefined,
  };

  return (
    <RecentProjectsSectionView
      source={source}
      searchQuery={searchQuery}
      loading={desktop.loading}
      error={desktop.error}
      reload={desktop.reload}
    />
  );
};
