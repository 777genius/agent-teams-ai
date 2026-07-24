import { ReviewDirectMutationDiskService } from '../application/ReviewDirectMutationDiskService';
import { ReviewMutationRecoveryApplication } from '../application/ReviewMutationRecoveryApplication';

import type {
  ReviewMutationContentCachePort,
  ReviewMutationCoordinatorPort,
  ReviewMutationDecisionPort,
  ReviewMutationDiskApplierPort,
  ReviewMutationJournalRepositoryPort,
  ReviewMutationLoggerPort,
  ReviewMutationRecoveryDependencies,
  ReviewMutationScopePort,
} from '../application/ReviewMutationRecoveryPorts';

export interface ReviewMutationRecoveryFeatureDependencies {
  scope: ReviewMutationScopePort;
  decisions: ReviewMutationDecisionPort;
  journal: ReviewMutationJournalRepositoryPort;
  coordinator: ReviewMutationCoordinatorPort;
  applier: ReviewMutationDiskApplierPort;
  cache: ReviewMutationContentCachePort;
  applyDecisionBatchDisk: ReviewMutationRecoveryDependencies['applyDecisionBatchDisk'];
  logger: ReviewMutationLoggerPort;
}

export function createReviewMutationRecoveryFeature(
  dependencies: ReviewMutationRecoveryFeatureDependencies
): ReviewMutationRecoveryApplication {
  const disk = new ReviewDirectMutationDiskService({
    scope: dependencies.scope,
    journal: dependencies.journal,
    applier: dependencies.applier,
    cache: dependencies.cache,
    logger: dependencies.logger,
  });
  return new ReviewMutationRecoveryApplication({
    scope: dependencies.scope,
    decisions: dependencies.decisions,
    journal: dependencies.journal,
    coordinator: dependencies.coordinator,
    disk,
    applyDecisionBatchDisk: dependencies.applyDecisionBatchDisk,
    logger: dependencies.logger,
  });
}
