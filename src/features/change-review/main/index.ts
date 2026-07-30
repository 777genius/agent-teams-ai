import * as reviewFileWatchComposition from './composition/createReviewFileWatchFeature';

import type {
  ReviewFileWatchConfiguration,
  ReviewFileWatchOperation,
} from './application/ReviewFileWatchPorts';

export {
  assertReviewDecisionShape,
  parseReviewDecisionPersistenceScope,
  parseReviewHistoryScopeIdentity,
  type ReviewHistoryScopeIdentity,
} from '../core/domain/reviewDecisionPersistencePolicy';
export { normalizeReviewWatchedFiles } from '../core/domain/reviewFileWatchPolicy';
export {
  sanitizeTaskChangeOptions,
  sanitizeTeamTaskChangeSummaryRequests,
} from '../core/domain/reviewQueryPolicy';
export {
  assertHunkIndices,
  assertNonEmptyString,
  assertOptionalString,
  assertSnippetShapes,
  MAX_REVIEW_HUNK_DECISIONS_PER_FILE,
  MAX_REVIEW_SNIPPETS_PER_FILE,
} from '../core/domain/reviewScopePolicy';
export { ReviewDecisionPersistenceApplication } from './application/ReviewDecisionPersistenceApplication';
export type {
  ReviewDecisionHistoryScopeAuthorization,
  ReviewDecisionPersistenceDependencies,
  ReviewDecisionPersistenceLockPort,
  ReviewDecisionPersistencePathPort,
  ReviewDecisionPersistenceScopePort,
  ReviewDraftHistoryScopeAuthorization,
} from './application/ReviewDecisionPersistencePorts';
export { ReviewFileWatchApplication } from './application/ReviewFileWatchApplication';
export type {
  ReviewFileWatchConfiguration,
  ReviewFileWatchDependencies,
  ReviewFileWatcherPort,
  ReviewFileWatchEventPort,
  ReviewFileWatchOperation,
  ReviewProjectPathValidator,
} from './application/ReviewFileWatchPorts';
export { ReviewQueryApplication } from './application/ReviewQueryApplication';
export type {
  ReviewQueryChangesPort,
  ReviewQueryContentPort,
  ReviewQueryDependencies,
  ReviewQueryGitHistoryPort,
  ReviewQueryGitLogEntry,
  ReviewQueryScopePort,
  ReviewQuerySnapshotPort,
} from './application/ReviewQueryPorts';
export { ReviewScopeAuthorizationApplication } from './application/ReviewScopeAuthorizationApplication';
export type {
  AuthorizedReviewRoot,
  ReviewPathAuthorization,
  ReviewScopeAuthorizationDependencies,
  ReviewScopeChangesPort,
  ReviewScopeConfigPort,
  ReviewScopeContentPort,
  ReviewScopeFileStat,
  ReviewScopeFileSystemPort,
  ReviewScopePathPort,
} from './application/ReviewScopeAuthorizationPorts';
export {
  createReviewDecisionPersistenceFeature,
  type ReviewDecisionPersistenceFeatureDependencies,
} from './composition/createReviewDecisionPersistenceFeature';
export { createReviewQueryFeature } from './composition/createReviewQueryFeature';
export {
  createReviewScopeAuthorizationFeature,
  type ReviewScopeAuthorizationFeatureDependencies,
} from './composition/createReviewScopeAuthorizationFeature';

export interface ReviewFileWatchWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

export interface ReviewFileWatchFeature {
  supersedePendingRequests(): void;
  configure(configuration: ReviewFileWatchConfiguration): void;
  prepareWatch(projectPath: string, filePaths: unknown): ReviewFileWatchOperation;
  prepareUnwatch(): ReviewFileWatchOperation;
  dispose(): void;
  setMainWindow(window: ReviewFileWatchWindow | null): void;
}

interface ReviewFileWatchRuntime extends Omit<ReviewFileWatchFeature, 'setMainWindow'> {
  setMainWindow(window: never): void;
}

interface ReviewFileWatchFeatureFactoryPort {
  create(): ReviewFileWatchRuntime;
}

const reviewFileWatchFeatureFactory: ReviewFileWatchFeatureFactoryPort = {
  create: () => reviewFileWatchComposition.createReviewFileWatchFeature(),
};

export function createReviewFileWatchFeature(): ReviewFileWatchFeature {
  const feature = reviewFileWatchFeatureFactory.create();
  return {
    supersedePendingRequests: () => feature.supersedePendingRequests(),
    configure: (configuration) => feature.configure(configuration),
    prepareWatch: (projectPath, filePaths) => feature.prepareWatch(projectPath, filePaths),
    prepareUnwatch: () => feature.prepareUnwatch(),
    dispose: () => feature.dispose(),
    setMainWindow: (window) => feature.setMainWindow(window as never),
  };
}
