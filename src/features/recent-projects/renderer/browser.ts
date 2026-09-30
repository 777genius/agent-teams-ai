/** Narrow browser-safe Recent Projects UI entrypoint. */
export type { RecentProjectsCollectionSource } from './hooks/useRecentProjectsCollection';
export { RecentProjectsSectionView } from './ui/RecentProjectsSectionView';
export type {
  ActionState,
  Fact,
  OpenResult,
  RecentProjectCardModel,
  RecentProjectIdentity,
} from './ui/recentProjectsModel';
export { sortRecentProjectPriority } from './utils/recentProjectPriority';
export type { RecentProjectPriorityFacts } from './utils/recentProjectPriority';
