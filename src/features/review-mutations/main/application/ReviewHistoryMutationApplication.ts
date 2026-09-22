import { createHash } from 'node:crypto';

import { threeWayTextMerge } from '@shared/utils/threeWayTextMerge';

import {
  assertAuthoritativelyBoundReviewAction,
  assertExactReviewHistoryTransition,
  findLatestRestorableDiskSnapshot,
  isAuthoritativeReviewDeletion,
  rebindReviewActionDescriptorPath,
} from '../../core/domain/reviewHistoryMutationPolicy';

import type {
  ReviewHistoryMutationCurrentState,
  ReviewHistoryMutationDependencies,
} from './ReviewHistoryMutationPorts';
import type { ReviewMutationPathAuthorization } from './ReviewMutationRecoveryPorts';
import type {
  ExecuteReviewMutationRequest,
  ReviewDiskUndoSnapshot,
  ReviewFileScope,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types/review';

function hasDiskPostimage(
  snapshot: ReviewDiskUndoSnapshot | null
): snapshot is ReviewDiskUndoSnapshot & { afterContent: string } {
  return typeof snapshot?.afterContent === 'string';
}

export class ReviewHistoryMutationApplication {
  constructor(private readonly dependencies: ReviewHistoryMutationDependencies) {}

  assertExactTransition(
    request: ExecuteReviewMutationRequest,
    current: ReviewHistoryMutationCurrentState,
    authorization: ReviewMutationPathAuthorization
  ): void {
    assertExactReviewHistoryTransition(request, current, {
      resolveFile: (filePath) =>
        this.dependencies.scope.getAuthoritativeFile(authorization, filePath),
      normalizePath: (filePath) => this.dependencies.scope.normalizeIdentityPath(filePath),
      hashContent: (content) => this.hashContent(content),
    });
  }

  assertAuthoritativelyBoundAction(action: ReviewUndoAction): void {
    assertAuthoritativelyBoundReviewAction(action, (content) => this.hashContent(content));
  }

  async bindNewHistorySnapshots(
    state: ReviewPersistedStateSnapshot,
    current: ReviewHistoryMutationCurrentState,
    scope: ReviewFileScope | null,
    authorization: ReviewMutationPathAuthorization | null
  ): Promise<ReviewPersistedStateSnapshot> {
    const trustedActions = new Map<string, ReviewUndoAction>();
    const trustedRedo = new Map<string, ReviewRedoAction>();
    for (const action of current?.reviewActionHistory ?? []) trustedActions.set(action.id, action);
    for (const entry of current?.reviewRedoHistory ?? []) {
      trustedActions.set(entry.action.id, entry.action);
      trustedRedo.set(entry.action.id, entry);
    }
    const bindAction = (action: ReviewUndoAction): Promise<ReviewUndoAction> => {
      const trusted = trustedActions.get(action.id);
      return trusted
        ? Promise.resolve(trusted)
        : this.bindNewAction(action, current, scope, authorization);
    };
    return {
      ...state,
      reviewActionHistory: await Promise.all((state.reviewActionHistory ?? []).map(bindAction)),
      reviewRedoHistory: await Promise.all(
        (state.reviewRedoHistory ?? []).map(async (entry) => {
          const trusted = trustedRedo.get(entry.action.id);
          return trusted ?? { ...entry, action: await bindAction(entry.action) };
        })
      ),
    };
  }

  async bindAuthoritativeForwardMutation(
    request: ExecuteReviewMutationRequest,
    current: ReviewHistoryMutationCurrentState,
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization
  ): Promise<ReviewPersistedStateSnapshot> {
    if (request.kind !== 'restore' && request.kind !== 'rename') return request.persistedState;
    const action = request.persistedState.reviewActionHistory.at(-1);
    if (action?.kind !== 'disk' || action.action.originalIndex !== undefined) {
      throw new Error(`Invalid durable ${request.kind === 'rename' ? 'Rename' : 'Restore'} action`);
    }
    const snapshot = action.action.snapshot;
    const filePath = await this.dependencies.scope.validateFilePath(
      authorization,
      snapshot.filePath,
      {
        requireReviewedFile: true,
        rejectHardlinks: true,
      }
    );
    const authoritativeFile = this.dependencies.scope.getAuthoritativeFile(
      authorization,
      snapshot.filePath
    );
    const restoreMode =
      snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');

    if (request.kind === 'rename') {
      if (restoreMode !== 'reapply-rejected-rename' || !snapshot.renameExpectation) {
        throw new Error('Review Rename mode does not match authoritative rename recovery');
      }
      const boundSnapshot = await this.bindNewDiskSnapshot(snapshot, scope, authorization);
      return {
        ...request.persistedState,
        reviewActionHistory: [
          ...request.persistedState.reviewActionHistory.slice(0, -1),
          {
            ...action,
            descriptor: rebindReviewActionDescriptorPath(action, boundSnapshot.filePath),
            action: { ...action.action, snapshot: boundSnapshot, file: authoritativeFile },
          },
        ],
      };
    }

    if (snapshot.renameExpectation || restoreMode.includes('rename')) {
      throw new Error('Review Restore cannot use rename recovery metadata');
    }
    const authoritativeContent = await this.dependencies.scope.resolveAuthoritativeContent(
      scope,
      authorization,
      filePath
    );
    const previous = findLatestRestorableDiskSnapshot(current, filePath, {
      normalizePath: (candidatePath) =>
        this.dependencies.scope.normalizeIdentityPath(candidatePath),
      hashContent: (content) => this.hashContent(content),
    });
    const observedBeforeContent = await this.readDiskContent(filePath);

    let expectedAfterContent: string | null;
    if (isAuthoritativeReviewDeletion(authoritativeFile)) {
      if (restoreMode !== 'create-file' || observedBeforeContent === null) {
        throw new Error('Review Restore deletion preimage or mode is not authoritative');
      }
      expectedAfterContent = null;
    } else if (authoritativeContent.isNewFile) {
      if (!hasDiskPostimage(previous)) {
        if (restoreMode !== 'delete-file' || observedBeforeContent !== null) {
          throw new Error('A file now exists at this reviewed new-file path; refusing Restore');
        }
        expectedAfterContent = previous?.beforeContent ?? authoritativeContent.modifiedFullContent;
        if (expectedAfterContent === null) {
          throw new Error('Authoritative agent content is unavailable; refusing Restore');
        }
      } else {
        if (restoreMode !== 'content' || observedBeforeContent === null) {
          throw new Error('Review Restore new-file preimage or mode is not authoritative');
        }
        const merged = threeWayTextMerge(
          previous.afterContent,
          observedBeforeContent,
          previous.beforeContent
        );
        if (merged.hasConflicts) {
          throw new Error('Agent changes conflict with edits made after rejection.');
        }
        expectedAfterContent = merged.content;
      }
    } else {
      if (restoreMode !== 'content' || observedBeforeContent === null) {
        throw new Error('Review Restore content preimage or mode is not authoritative');
      }
      const desiredContent = previous?.beforeContent ?? authoritativeContent.modifiedFullContent;
      if (desiredContent === null) {
        throw new Error('Authoritative agent content is unavailable; refusing Restore');
      }
      const rejectedBaseline = previous?.afterContent ?? authoritativeContent.originalFullContent;
      if (rejectedBaseline === null) {
        throw new Error('Authoritative rejected baseline is unavailable; refusing Restore');
      }
      const merged = threeWayTextMerge(rejectedBaseline, observedBeforeContent, desiredContent);
      if (merged.hasConflicts) {
        throw new Error('Agent changes conflict with edits made after rejection.');
      }
      expectedAfterContent = merged.content;
    }

    const expectedBeforeContent = observedBeforeContent ?? '';
    if (snapshot.beforeContent !== expectedBeforeContent) {
      throw new Error('Review Restore preimage does not match the current reviewed file');
    }
    if (snapshot.afterContent !== expectedAfterContent) {
      throw new Error('Review Restore content does not match authoritative review history');
    }
    const boundSnapshot: ReviewDiskUndoSnapshot = {
      ...snapshot,
      filePath,
      beforeContent: expectedBeforeContent,
      authoritativeBeforeSha256:
        observedBeforeContent === null ? null : this.hashContent(observedBeforeContent),
      file: authoritativeFile,
      restoreMode,
      renameExpectation: undefined,
      restoreConflict: undefined,
    };
    return {
      ...request.persistedState,
      reviewActionHistory: [
        ...request.persistedState.reviewActionHistory.slice(0, -1),
        {
          ...action,
          descriptor: rebindReviewActionDescriptorPath(action, boundSnapshot.filePath),
          action: { ...action.action, snapshot: boundSnapshot, file: authoritativeFile },
        },
      ],
    };
  }

  private async bindNewAction(
    action: ReviewUndoAction,
    current: ReviewHistoryMutationCurrentState,
    scope: ReviewFileScope | null,
    authorization: ReviewMutationPathAuthorization | null
  ): Promise<ReviewUndoAction> {
    if (action.kind === 'hunk') return action;
    const decisionSnapshot = {
      hunkDecisions: { ...(current?.hunkDecisions ?? {}) },
      fileDecisions: { ...(current?.fileDecisions ?? {}) },
    };
    if (action.kind === 'bulk') {
      if (action.diskSnapshots.length === 0) return action;
      if (!scope || !authorization) {
        throw new Error('Review scope is unavailable for a new disk history action');
      }
      return {
        ...action,
        decisionSnapshot,
        diskSnapshots: await Promise.all(
          action.diskSnapshots.map((snapshot) =>
            this.bindNewDiskSnapshot(snapshot, scope, authorization)
          )
        ),
      };
    }
    if (!scope || !authorization) {
      throw new Error('Review scope is unavailable for a new disk history action');
    }
    const snapshot = await this.bindNewDiskSnapshot(action.action.snapshot, scope, authorization);
    return {
      ...action,
      descriptor: rebindReviewActionDescriptorPath(action, snapshot.filePath),
      action: {
        ...action.action,
        snapshot,
        file: snapshot.file,
        ...(action.action.originalIndex === undefined ? { decisionSnapshot } : {}),
      },
    };
  }

  private async bindNewDiskSnapshot(
    snapshot: ReviewDiskUndoSnapshot,
    scope: ReviewFileScope,
    authorization: ReviewMutationPathAuthorization
  ): Promise<ReviewDiskUndoSnapshot> {
    const filePath = await this.dependencies.scope.validateFilePath(
      authorization,
      snapshot.filePath,
      {
        requireReviewedFile: true,
        rejectHardlinks: true,
      }
    );
    const file = this.dependencies.scope.getAuthoritativeFile(authorization, filePath);
    const restoreMode =
      snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
    const isRenameMode =
      restoreMode === 'restore-rejected-rename' || restoreMode === 'reapply-rejected-rename';

    if (isRenameMode || snapshot.renameExpectation) {
      if (!isRenameMode || !snapshot.renameExpectation) {
        throw new Error('Rename recovery metadata does not match the review history mode');
      }
      const expectation = this.dependencies.scope.parseRenameExpectation(
        snapshot.renameExpectation
      );
      const authoritativeContent = await this.dependencies.scope.resolveAuthoritativeContent(
        scope,
        authorization,
        filePath
      );
      this.dependencies.scope.assertExpectedRename(authoritativeContent, expectation);
      return {
        ...snapshot,
        filePath,
        beforeContent: '',
        afterContent: null,
        authoritativeBeforeSha256: null,
        file,
        restoreMode,
        renameExpectation: expectation,
        restoreConflict: undefined,
      };
    }

    const beforeContent = await this.readDiskContent(filePath);
    if (beforeContent === null && restoreMode !== 'delete-file') {
      throw new Error('Review history preimage is missing; refusing an unsafe disk action');
    }
    const authoritativeContent = await this.dependencies.scope.resolveAuthoritativeContent(
      scope,
      authorization,
      filePath
    );
    if (restoreMode === 'create-file' && !authoritativeContent.isNewFile) {
      throw new Error('Create-file review history does not match an authoritative new file');
    }
    if (restoreMode === 'delete-file' && !isAuthoritativeReviewDeletion(file)) {
      throw new Error('Delete-file review history does not match an authoritative deletion');
    }

    let afterContent: string | null;
    if (restoreMode === 'create-file') {
      afterContent = null;
    } else if (restoreMode === 'delete-file') {
      afterContent = authoritativeContent.originalFullContent;
      if (afterContent === null) {
        throw new Error('Authoritative deleted-file baseline is unavailable');
      }
    } else {
      afterContent = beforeContent;
    }

    return {
      ...snapshot,
      filePath,
      beforeContent: beforeContent ?? '',
      afterContent,
      authoritativeBeforeSha256: beforeContent === null ? null : this.hashContent(beforeContent),
      file,
      restoreMode,
      renameExpectation: undefined,
      restoreConflict: undefined,
    };
  }

  private async readDiskContent(filePath: string): Promise<string | null> {
    try {
      return await this.dependencies.files.readText(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    }
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
