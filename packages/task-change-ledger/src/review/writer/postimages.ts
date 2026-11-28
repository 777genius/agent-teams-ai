import type {
  FileChangeWithContent,
  ReviewPersistedStateSnapshot,
  ReviewDiskUndoSnapshot,
} from '../../contracts.js';
import type {
  ReviewMutationJournalPathPostimage,
  ReviewMutationJournalPathTransition,
} from '../storage/ReviewMutationJournalStore.js';
import { normalizeReviewPathForIdentity } from './scopeAuthorization.js';
import { createHash } from 'crypto';
import { inspectReviewFileTransaction } from '../io/index.js';
import { threeWayTextMerge } from '../apply/threeWayTextMerge.js';
import { hashReviewPreimage } from './historyBinding.js';

import * as fs from 'fs/promises';

export async function readReviewMutationPathPostimages(
  fileContent: FileChangeWithContent
): Promise<{
  durable: ReviewMutationJournalPathPostimage[];
  contents: Map<string, string | null>;
}> {
  const paths = new Map<string, string>();
  for (const filePath of [fileContent.filePath, ...fileContent.snippets.map((s) => s.filePath)]) {
    paths.set(normalizeReviewPathForIdentity(filePath), filePath);
  }
  const durable: ReviewMutationJournalPathPostimage[] = [];
  const contents = new Map<string, string | null>();
  for (const filePath of paths.values()) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      contents.set(filePath, content);
      durable.push({ filePath, sha256: createHash('sha256').update(content).digest('hex') });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        contents.set(filePath, null);
        durable.push({ filePath, sha256: null });
      } else {
        throw error;
      }
    }
  }
  return { durable, contents };
}

export async function assertReviewMutationPathPostimages(
  postimages: readonly ReviewMutationJournalPathPostimage[]
): Promise<void> {
  if (postimages.length === 0) {
    throw new Error('Applied review mutation has no durable postimage evidence');
  }
  for (const postimage of postimages) {
    let currentSha256: string | null;
    try {
      currentSha256 = createHash('sha256')
        .update(await fs.readFile(postimage.filePath, 'utf8'))
        .digest('hex');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') currentSha256 = null;
      else throw error;
    }
    if (currentSha256 !== postimage.sha256) {
      throw new Error(
        `Review mutation postimage changed after crash; refusing recovery for ${postimage.filePath}`
      );
    }
  }
}

export async function reconcileLatestReviewActionPostimages(
  state: ReviewPersistedStateSnapshot,
  postimages: ReadonlyMap<string, string | null>,
  transitions: readonly ReviewMutationJournalPathTransition[]
): Promise<ReviewPersistedStateSnapshot> {
  const latest = state.reviewActionHistory.at(-1);
  if (!latest) return state;
  const resolvePostimage = (filePath: string): string | null | undefined => {
    for (const [candidatePath, content] of postimages) {
      if (
        normalizeReviewPathForIdentity(candidatePath) === normalizeReviewPathForIdentity(filePath)
      ) {
        return content;
      }
    }
    return undefined;
  };
  const resolveTransition = (filePath: string): ReviewMutationJournalPathTransition | undefined =>
    transitions.find(
      (transition) =>
        normalizeReviewPathForIdentity(transition.filePath) ===
        normalizeReviewPathForIdentity(filePath)
    );
  const getTransaction = (transition: ReviewMutationJournalPathTransition) => {
    const { operation, transactionId, beforeContent, afterContent } = transition;
    if (!operation || !transactionId || beforeContent === null) return null;
    if (operation === 'move') {
      if (!transition.relatedFilePath || afterContent === null) return null;
      return {
        id: transactionId,
        kind: 'move' as const,
        sourcePath: transition.filePath,
        targetPath: transition.relatedFilePath,
        expectedContent: beforeContent,
        nextContent: afterContent,
      };
    }
    return {
      id: transactionId,
      kind: operation,
      sourcePath: transition.filePath,
      targetPath: transition.filePath,
      expectedContent: beforeContent,
      nextContent: operation === 'delete' ? null : afterContent,
    };
  };
  const hasPublishedTransaction = async (
    transition: ReviewMutationJournalPathTransition | undefined
  ): Promise<boolean> => {
    if (!transition) return false;
    const transaction = getTransaction(transition);
    return transaction
      ? (await inspectReviewFileTransaction(transaction)) === 'published'
      : transition.operation === undefined;
  };
  const reconcileSnapshot = async (
    snapshot: ReviewDiskUndoSnapshot
  ): Promise<ReviewDiskUndoSnapshot> => {
    if (snapshot.renameExpectation) {
      const transition =
        resolveTransition(snapshot.filePath) ??
        transitions.find(
          (candidate) =>
            candidate.transactionId &&
            candidate.operation &&
            normalizeReviewPathForIdentity(candidate.relatedFilePath ?? '') ===
              normalizeReviewPathForIdentity(snapshot.filePath)
        );
      if (!(await hasPublishedTransaction(transition))) {
        return {
          ...snapshot,
          restoreConflict:
            'Reject rename provenance is unavailable; refusing an unsafe Undo or Restore.',
        };
      }
      return { ...snapshot, restoreConflict: undefined };
    }
    const actual = resolvePostimage(snapshot.filePath);
    if (actual === undefined) return snapshot;
    const transition = resolveTransition(snapshot.filePath);
    if (!transition) {
      return {
        ...snapshot,
        afterContent: actual,
        restoreConflict: 'Reject lock preimage is unavailable; refusing an unsafe Undo or Restore.',
      };
    }
    if (
      transition.beforeContent === transition.afterContent &&
      (snapshot.restoreMode === 'create-file' || snapshot.restoreMode === 'delete-file')
    ) {
      return {
        ...snapshot,
        afterContent: actual,
        restoreConflict:
          'Reject did not prove this file-presence change; refusing an unsafe Undo or Restore.',
      };
    }
    if (!(await hasPublishedTransaction(transition))) {
      return {
        ...snapshot,
        afterContent: actual,
        restoreConflict:
          'Reject filesystem transaction is not durably published; refusing an unsafe Undo or Restore.',
      };
    }
    let beforeContent = transition.beforeContent;
    if (actual !== transition.afterContent) {
      if (
        typeof actual !== 'string' ||
        typeof transition.afterContent !== 'string' ||
        typeof transition.beforeContent !== 'string'
      ) {
        return {
          ...snapshot,
          afterContent: actual,
          restoreConflict:
            'Reject postimage changed across a file-presence transition; refusing an unsafe Undo or Restore.',
        };
      }
      const merged = threeWayTextMerge(transition.afterContent, actual, transition.beforeContent);
      if (!merged.hasConflicts) {
        beforeContent = merged.content;
      } else {
        return {
          ...snapshot,
          afterContent: actual,
          restoreConflict:
            'Reject preserved concurrent edits that cannot be reconstructed safely; refusing Undo or Restore.',
        };
      }
    }
    return {
      ...snapshot,
      beforeContent: beforeContent ?? '',
      afterContent: actual,
      authoritativeBeforeSha256: beforeContent === null ? null : hashReviewPreimage(beforeContent),
      restoreConflict: undefined,
    };
  };
  let reconciled = latest;
  if (latest.kind === 'disk') {
    const snapshot = await reconcileSnapshot(latest.action.snapshot);
    if (snapshot !== latest.action.snapshot) {
      reconciled = {
        ...latest,
        action: {
          ...latest.action,
          snapshot,
        },
      };
    }
  } else if (latest.kind === 'bulk') {
    reconciled = {
      ...latest,
      diskSnapshots: await Promise.all(latest.diskSnapshots.map(reconcileSnapshot)),
    };
  }
  if (reconciled === latest) return state;
  return {
    ...state,
    reviewActionHistory: [...state.reviewActionHistory.slice(0, -1), reconciled],
  };
}
