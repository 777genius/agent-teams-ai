import * as io from '../io/index.js';
import { reviewApplyMutationContext } from './applyContext.js';

/** Only threads the captured guard into existing filesystem algorithms. */
export function createPublicationIO(assertCurrent?: () => void) {
  const guard = assertCurrent ? { assertCurrent } : {};
  return {
    ...io,
    atomicCreateAsync: (
      path: string,
      bytes: string | Buffer,
      options: Parameters<typeof io.atomicCreateAsync>[2] = {}
    ) =>
      io.atomicCreateAsync(path, bytes, {
        ...options,
        ...guard,
        onPublished(identity) {
          reviewApplyMutationContext.getStore()?.hooks?.publishedCreate?.(path, identity);
          options.onPublished?.(identity);
        },
      }),
    prepareReviewFileTransaction: (
      input: Parameters<typeof io.prepareReviewFileTransaction>[0],
      options: Parameters<typeof io.prepareReviewFileTransaction>[1] = {}
    ) => io.prepareReviewFileTransaction(input, { ...options, ...guard }),
    executeReviewFileTransaction: (
      input: Parameters<typeof io.executeReviewFileTransaction>[0],
      options: Parameters<typeof io.executeReviewFileTransaction>[1] = {}
    ) => io.executeReviewFileTransaction(input, { ...options, ...guard }),
    resumePreparedReviewFileTransaction: (
      input: Parameters<typeof io.resumePreparedReviewFileTransaction>[0]
    ) => io.resumePreparedReviewFileTransaction(input, guard),
    finalizePreparedReviewFileTransaction: (
      input: Parameters<typeof io.finalizePreparedReviewFileTransaction>[0]
    ) => io.finalizePreparedReviewFileTransaction(input, guard),
    finalizeReviewFileTransaction: (
      input: Parameters<typeof io.finalizeReviewFileTransaction>[0]
    ) => io.finalizeReviewFileTransaction(input, guard),
  };
}
