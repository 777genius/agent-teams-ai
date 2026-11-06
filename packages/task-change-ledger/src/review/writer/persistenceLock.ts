import type { ReviewWriterContext } from './ports.js';
import type { ReviewDecisionPersistenceScope } from '../../contracts.js';

export async function withReviewDecisionPersistenceLock<T>(
  env: Pick<ReviewWriterContext, 'assertActive' | 'locks' | 'queues'>,
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${teamName}:${persistenceScope.scopeKey}`;
  const previous = env.queues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueTail = previous.then(
    () => current,
    () => current
  );
  env.queues.set(key, queueTail);
  await previous.catch(() => undefined);
  try {
    return await env.locks.withReviewPersistenceLogicalScopeLock(
      teamName,
      persistenceScope.scopeKey,
      () => env.locks.withReviewPersistenceScopeLock(teamName, persistenceScope, operation)
    );
  } finally {
    release();
    if (env.queues.get(key) === queueTail) {
      env.queues.delete(key);
    }
  }
}
