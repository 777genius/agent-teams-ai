/** Browser-safe public facet for Hosted Dashboard composition. */
export type { RecentProjectsCollectionSource } from './hooks/useRecentProjectsCollection';
export type {
  OpenResult,
  RecentProjectCardModel,
  RecentProjectIdentity,
} from './ui/recentProjectsModel';
export { RecentProjectsSectionView } from './ui/RecentProjectsSectionView';
export { sortRecentProjectPriority } from './utils/recentProjectPriority';
