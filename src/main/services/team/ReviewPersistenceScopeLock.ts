import { createReviewPersistenceLocks } from '@agent-teams/task-change-ledger/review-storage';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { readProcessStartTimeMs } from '@main/utils/processStartTime';

import type { ReviewPersistenceScopeLockOptions } from '@agent-teams/task-change-ledger/review-storage';
import type { ReviewDecisionPersistenceScope } from '@shared/types/review';
const managers = new Map<string, ReturnType<typeof createReviewPersistenceLocks>>();
function manager() {
  const root = getTeamsBasePath();
  let value = managers.get(root);
  if (!value) {
    value = createReviewPersistenceLocks(root, readProcessStartTimeMs);
    managers.set(root, value);
  }
  return value;
}
export function withReviewPersistenceScopeLock<T>(
  teamName: string,
  scope: ReviewDecisionPersistenceScope,
  operation: () => Promise<T>,
  options: ReviewPersistenceScopeLockOptions = {}
): Promise<T> {
  return manager().withReviewPersistenceScopeLock(teamName, scope, operation, options);
}
export function withReviewPersistenceLogicalScopeLock<T>(
  teamName: string,
  scopeKey: string,
  operation: () => Promise<T>,
  options: ReviewPersistenceScopeLockOptions = {}
): Promise<T> {
  return manager().withReviewPersistenceLogicalScopeLock(teamName, scopeKey, operation, options);
}
export function closeReviewPersistenceScopeLockDatabasesForTests() {
  for (const value of managers.values()) value.closeReviewPersistenceScopeLockDatabasesForTests();
  managers.clear();
}
