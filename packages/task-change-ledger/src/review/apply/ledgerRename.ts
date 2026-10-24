import type {
  LedgerChangeRelation,
  ReviewMutationDiskPostimage,
  SnippetDiff,
} from '../../contracts.js';
import {
  type LedgerApplyOutcome,
  type ReviewRenameTransitionState,
  getCurrentTextReadError,
  withFileMutationLocks,
  type ApplierContext,
} from './applyContext.js';

export function createLedgerRename(getContext: () => ApplierContext) {
  return {
    async classifyRejectedRenameTransition(
      filePath: string,
      original: string | null,
      modified: string | null,
      snippets: SnippetDiff[]
    ): Promise<ReviewRenameTransitionState> {
      const ctx = getContext();
      const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
      const relation = ctx.resolveLedgerRelation(ledgerSnippets);
      if (relation?.kind !== 'rename') {
        throw new Error('Review file is not a ledger rename.');
      }
      const endpoints = ctx.resolveLedgerRenameEndpoints(ledgerSnippets, relation);
      const oldSnippet = endpoints?.oldSnippet;
      const newSnippet = endpoints?.newSnippet;
      const oldFilePath = endpoints?.oldFilePath;
      const newFilePath = endpoints?.newFilePath;
      const oldContent = oldSnippet?.ledger?.originalFullContent ?? original;
      const newContent = newSnippet?.ledger?.modifiedFullContent ?? modified;
      if (!oldFilePath || !newFilePath || oldContent === null || newContent === null) {
        throw new Error('Ledger rename recovery metadata is incomplete.');
      }
      if (
        ledgerSnippets.some(
          (snippet) =>
            snippet.ledger?.beforeState?.unavailableReason ||
            snippet.ledger?.afterState?.unavailableReason
        )
      ) {
        throw new Error('Ledger rename recovery content is unavailable.');
      }

      return withFileMutationLocks(
        ctx.resolveLedgerMutationPaths(filePath, ledgerSnippets),
        async () => {
          const resumedTransaction = await ctx.io.resumePreparedReviewFileTransaction({
            kind: 'move',
            sourcePath: oldFilePath,
            targetPath: newFilePath,
            expectedContent: oldContent,
            nextContent: newContent,
          });
          const ownsPublishedTarget = resumedTransaction
            ? (await ctx.io.inspectReviewFileTransaction(resumedTransaction)) === 'published'
            : false;
          if (resumedTransaction && !ownsPublishedTarget) {
            throw new Error('Review file transaction evidence is unavailable or conflicted');
          }
          const oldCurrent = await ctx.readCurrentText(oldFilePath);
          const oldError = getCurrentTextReadError(oldCurrent);
          if (oldError) throw new Error(oldError);
          const newCurrent = await ctx.readCurrentText(newFilePath);
          const newError = getCurrentTextReadError(newCurrent);
          if (newError) throw new Error(newError);
          const aliased =
            !oldCurrent.missing &&
            !newCurrent.missing &&
            (await ctx.pathsReferToSameFile(oldFilePath, newFilePath));
          if (!oldCurrent.missing) {
            await ctx.assertSafeExpectedFile(oldFilePath, oldCurrent.content, aliased);
          }
          if (!newCurrent.missing) {
            await ctx.assertSafeExpectedFile(
              newFilePath,
              newCurrent.content,
              aliased || ownsPublishedTarget
            );
          }
          if (aliased) {
            const spelling = await ctx.caseOnlyRenameEntry(oldFilePath, newFilePath);
            const content = oldCurrent.content;
            if (spelling === 'new') {
              if (content === newContent) return 'accepted';
              if (content === oldContent) return 'restoring';
            } else {
              if (content === oldContent) return 'rejected';
              if (content === newContent) return 'reapplying';
            }
            throw new Error('Ledger rename changed since review update; durable state is ambiguous');
          }
          const accepted =
            oldCurrent.missing && !newCurrent.missing && newCurrent.content === newContent;
          const rejected =
            !oldCurrent.missing && oldCurrent.content === oldContent && newCurrent.missing;
          if (accepted && rejected) return 'both';
          if (accepted) return 'accepted';
          if (rejected) return 'rejected';
          if (oldCurrent.missing && !newCurrent.missing && newCurrent.content === oldContent) {
            return 'restoring';
          }
          if (newCurrent.missing && !oldCurrent.missing && oldCurrent.content === newContent) {
            return 'reapplying';
          }
          if (
            !oldCurrent.missing &&
            oldCurrent.content === oldContent &&
            !newCurrent.missing &&
            newCurrent.content === newContent
          ) {
            return 'legacy-reapplying';
          }
          throw new Error('Ledger rename changed since review update; durable state is ambiguous');
        }
      );
    },
    async restoreRejectedRename(
      filePath: string,
      original: string | null,
      modified: string | null,
      snippets: SnippetDiff[]
    ): Promise<{ success: true }> {
      const ctx = getContext();
      const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
      const relation = ctx.resolveLedgerRelation(ledgerSnippets);
      if (relation?.kind !== 'rename') {
        throw new Error('Review file is not a ledger rename.');
      }

      return withFileMutationLocks(
        ctx.resolveLedgerMutationPaths(filePath, ledgerSnippets),
        async () => {
          await ctx.restoreRejectedLedgerRename(ledgerSnippets, relation, original, modified);
          return { success: true };
        }
      );
    },
    async reapplyRejectedRename(
      filePath: string,
      original: string | null,
      snippets: SnippetDiff[]
    ): Promise<{ success: true }> {
      const ctx = getContext();
      const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
      const relation = ctx.resolveLedgerRelation(ledgerSnippets);
      if (relation?.kind !== 'rename') {
        throw new Error('Review file is not a ledger rename.');
      }
      const hasUnavailableState = ledgerSnippets.some(
        (snippet) =>
          snippet.ledger?.beforeState?.unavailableReason ||
          snippet.ledger?.afterState?.unavailableReason
      );

      return withFileMutationLocks(
        ctx.resolveLedgerMutationPaths(filePath, ledgerSnippets),
        async () => {
          const outcome = await ctx.rejectLedgerRename(
            ledgerSnippets,
            relation,
            original,
            hasUnavailableState
          );
          if (outcome.handled && (outcome.status === 'applied' || outcome.status === 'skipped')) {
            return { success: true };
          }
          throw new Error(
            outcome.handled && 'error' in outcome
              ? outcome.error
              : 'Ledger rename reject was not handled.'
          );
        }
      );
    },
    async getRejectedRenamePostimages(
      original: string | null,
      modified: string | null,
      snippets: SnippetDiff[],
      direction: 'restore' | 'reapply'
    ): Promise<ReviewMutationDiskPostimage[]> {
      const ctx = getContext();
      const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
      const relation = ctx.resolveLedgerRelation(ledgerSnippets);
      if (relation?.kind !== 'rename') {
        throw new Error('Review file is not a ledger rename.');
      }
      const endpoints = ctx.resolveLedgerRenameEndpoints(ledgerSnippets, relation);
      const oldSnippet = endpoints?.oldSnippet;
      const newSnippet = endpoints?.newSnippet;
      const oldFilePath = endpoints?.oldFilePath;
      const newFilePath = endpoints?.newFilePath;
      const oldContent = oldSnippet?.ledger?.originalFullContent ?? original;
      const newContent = newSnippet?.ledger?.modifiedFullContent ?? modified;
      if (!oldFilePath || !newFilePath || oldContent === null || newContent === null) {
        throw new Error('Ledger rename recovery metadata is incomplete.');
      }
      if (
        ledgerSnippets.some(
          (snippet) =>
            snippet.ledger?.beforeState?.unavailableReason ||
            snippet.ledger?.afterState?.unavailableReason
        )
      ) {
        throw new Error('Ledger rename recovery content is unavailable.');
      }

      const aliased = await ctx.pathsReferToSameFile(oldFilePath, newFilePath);
      const finalContent = direction === 'restore' ? newContent : oldContent;
      if (aliased) {
        return [...new Set([oldFilePath, newFilePath])].map((filePath) => ({
          filePath,
          content: finalContent,
        }));
      }
      return direction === 'restore'
        ? [
            { filePath: oldFilePath, content: null },
            { filePath: newFilePath, content: newContent },
          ]
        : [
            { filePath: oldFilePath, content: oldContent },
            { filePath: newFilePath, content: null },
          ];
    },
    async rejectLedgerRename(
      snippets: SnippetDiff[],
      relation: LedgerChangeRelation,
      original: string | null,
      hasUnavailableState: boolean
    ): Promise<LedgerApplyOutcome> {
      const ctx = getContext();
      const oldSnippet =
        snippets.find(
          (snippet) =>
            snippet.ledger?.operation === 'delete' &&
            ctx.pathMatchesRelationPath(snippet.filePath, relation.oldPath)
        ) ?? snippets.find((snippet) => snippet.ledger?.operation === 'delete');
      const newSnippet =
        snippets.find(
          (snippet) =>
            snippet.ledger?.operation === 'create' &&
            ctx.pathMatchesRelationPath(snippet.filePath, relation.newPath)
        ) ?? snippets.find((snippet) => snippet.ledger?.operation === 'create');
      const oldFilePath =
        oldSnippet?.filePath ??
        ctx.resolveRelatedLedgerPath(newSnippet?.filePath, relation.newPath, relation.oldPath);
      const newFilePath = newSnippet?.filePath;
      const oldContent = oldSnippet?.ledger?.originalFullContent ?? original;
      const authoritativeNewContent = newSnippet?.ledger?.modifiedFullContent;
      const newHash = newSnippet?.ledger?.afterState?.sha256 ?? newSnippet?.ledger?.afterHash;
      const oldHash = oldSnippet?.ledger?.beforeState?.sha256 ?? oldSnippet?.ledger?.beforeHash;

      if (!oldFilePath || !newFilePath || oldContent === null) {
        return {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error: 'Ledger rename metadata is incomplete; manual review is required.',
        };
      }
      if (hasUnavailableState || !newHash) {
        return {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error: 'Ledger rename content metadata is unavailable; manual review is required.',
        };
      }

      if (typeof authoritativeNewContent === 'string') {
        await ctx.io.resumePreparedReviewFileTransaction({
          kind: 'move',
          sourcePath: newFilePath,
          targetPath: oldFilePath,
          expectedContent: authoritativeNewContent,
          nextContent: oldContent,
        });
      }

      const newCurrent = await ctx.readCurrentText(newFilePath);
      const newCurrentError = newCurrent.missing ? null : getCurrentTextReadError(newCurrent);
      if (newCurrentError) {
        return { handled: true, status: 'error', code: 'io-error', error: newCurrentError };
      }
      const oldCurrent = await ctx.readCurrentText(oldFilePath);
      const oldCurrentError = oldCurrent.missing ? null : getCurrentTextReadError(oldCurrent);
      if (oldCurrentError) {
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: oldCurrentError,
        };
      }
      const oldMatchesExpected =
        !oldCurrent.missing &&
        (oldHash
          ? ctx.hashText(oldCurrent.content) === oldHash
          : oldCurrent.content === oldContent);
      const newMatchesExpected =
        !newCurrent.missing && ctx.hashText(newCurrent.content) === newHash;
      const aliased =
        !oldCurrent.missing &&
        !newCurrent.missing &&
        (await ctx.pathsReferToSameFile(oldFilePath, newFilePath));

      if (aliased) {
        if (!newMatchesExpected && !oldMatchesExpected) {
          return {
            handled: true,
            status: 'conflict',
            code: 'conflict',
            error: 'Case-only rename content changed; refusing ledger reject.',
          };
        }
        if (
          oldMatchesExpected &&
          (await ctx.caseOnlyRenameEntry(oldFilePath, newFilePath)) === 'old'
        ) {
          return { handled: true, status: 'applied' };
        }
        const currentContent = newMatchesExpected ? newCurrent.content : oldCurrent.content;
        try {
          await ctx.moveExpectedTextFile(newFilePath, oldFilePath, currentContent, oldContent);
          return { handled: true, status: 'applied' };
        } catch (error) {
          return {
            handled: true,
            status: 'error',
            code: 'io-error',
            error: `Failed to reject case-only ledger rename: ${String(error)}`,
          };
        }
      }

      if (newCurrent.missing) {
        if (oldMatchesExpected) return { handled: true, status: 'applied' };
        // Crash after the durable path move but before the content replacement.
        if (!oldCurrent.missing && ctx.hashText(oldCurrent.content) === newHash) {
          try {
            await ctx.atomicReplaceTextFile(oldFilePath, oldCurrent.content, oldContent);
            return { handled: true, status: 'applied' };
          } catch (error) {
            return {
              handled: true,
              status: 'error',
              code: 'io-error',
              error: `Failed to finish interrupted ledger rename reject: ${String(error)}`,
            };
          }
        }
        return {
          handled: true,
          status: 'conflict',
          code: 'conflict',
          error: 'Renamed target path is missing; refusing to recreate the original path.',
        };
      }
      if (!newMatchesExpected) {
        return {
          handled: true,
          status: 'conflict',
          code: 'conflict',
          error: 'Renamed file was modified since review was computed; refusing ledger reject.',
        };
      }
      // Compatibility recovery for the old create-then-delete implementation.
      if (!oldCurrent.missing) {
        if (!oldMatchesExpected) {
          return {
            handled: true,
            status: 'conflict',
            code: 'conflict',
            error:
              'Original rename path already exists with different content; refusing overwrite.',
          };
        }
        try {
          await ctx.deleteExpectedTextFile(newFilePath, newCurrent.content);
          return { handled: true, status: 'applied' };
        } catch (error) {
          return {
            handled: true,
            status: 'error',
            code: 'io-error',
            error: `Failed to finish legacy ledger rename reject: ${String(error)}`,
          };
        }
      }

      try {
        await ctx.moveExpectedTextFile(newFilePath, oldFilePath, newCurrent.content, oldContent);
        return { handled: true, status: 'applied' };
      } catch (error) {
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: `Failed to reject ledger rename: ${String(error)}`,
        };
      }
    },
    async restoreRejectedLedgerRename(
      snippets: SnippetDiff[],
      relation: LedgerChangeRelation,
      original: string | null,
      modified: string | null
    ): Promise<void> {
      const ctx = getContext();
      const endpoints = ctx.resolveLedgerRenameEndpoints(snippets, relation);
      const oldSnippet = endpoints?.oldSnippet;
      const newSnippet = endpoints?.newSnippet;
      const oldFilePath = endpoints?.oldFilePath;
      const newFilePath = endpoints?.newFilePath;
      const oldContent = oldSnippet?.ledger?.originalFullContent ?? original;
      const newContent = newSnippet?.ledger?.modifiedFullContent ?? modified;

      if (!oldFilePath || !newFilePath || oldContent === null || newContent === null) {
        throw new Error('Ledger rename recovery metadata is incomplete.');
      }
      if (
        snippets.some(
          (snippet) =>
            snippet.ledger?.beforeState?.unavailableReason ||
            snippet.ledger?.afterState?.unavailableReason
        )
      ) {
        throw new Error('Ledger rename recovery content is unavailable.');
      }

      await ctx.io.resumePreparedReviewFileTransaction({
        kind: 'move',
        sourcePath: oldFilePath,
        targetPath: newFilePath,
        expectedContent: oldContent,
        nextContent: newContent,
      });

      const oldCurrent = await ctx.readCurrentText(oldFilePath);
      const oldReadError = getCurrentTextReadError(oldCurrent);
      if (oldReadError) throw new Error(oldReadError);
      const newCurrent = await ctx.readCurrentText(newFilePath);
      const newReadError = getCurrentTextReadError(newCurrent);
      if (newReadError) throw new Error(newReadError);
      const aliased =
        !oldCurrent.missing &&
        !newCurrent.missing &&
        (await ctx.pathsReferToSameFile(oldFilePath, newFilePath));

      if (aliased) {
        const spelling = await ctx.caseOnlyRenameEntry(oldFilePath, newFilePath);
        if (newCurrent.content === newContent && spelling === 'new') {
          return;
        }
        if (newCurrent.content !== oldContent && newCurrent.content !== newContent) {
          throw new Error('Case-only rename content changed after rejection; refusing Undo.');
        }
        try {
          await ctx.moveExpectedTextFile(oldFilePath, newFilePath, newCurrent.content, newContent);
          return;
        } catch (error) {
          throw new Error(`Failed to restore case-only ledger rename: ${String(error)}`);
        }
      }

      if (oldCurrent.missing) {
        if (!newCurrent.missing && newCurrent.content === newContent) return;
        // Crash after the path move but before publishing the target content.
        if (!newCurrent.missing && newCurrent.content === oldContent) {
          await ctx.atomicReplaceTextFile(newFilePath, oldContent, newContent);
          return;
        }
        throw new Error('Original rename path changed after rejection; refusing Undo.');
      }
      if (oldCurrent.content !== oldContent) {
        throw new Error('Original rename path changed after rejection; refusing Undo.');
      }
      if (!newCurrent.missing) {
        throw new Error('Renamed target path already exists; refusing Undo.');
      }

      try {
        await ctx.moveExpectedTextFile(oldFilePath, newFilePath, oldContent, newContent);
      } catch (error) {
        throw new Error(`Failed to restore ledger rename: ${String(error)}`);
      }
    },
  };
}
