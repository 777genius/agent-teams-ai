import { getReviewFileTransactionFromTransition } from './reviewFileTransition.js';
import { normalizePathForComparison } from '../../platformPath.js';
import { createHash } from 'crypto';
import { lstat, readFile } from 'fs/promises';
import type { ApplyReviewDiskTransition, SnippetDiff } from '../../contracts.js';
import {
  type ReviewApplyMutationContext,
  reviewApplyMutationContext,
  type CurrentTextReadResult,
  type ReviewFileTransitionState,
  getCurrentTextReadError,
  withFileMutationLock,
  type ApplierContext,
} from './applyContext.js';

export function createFileMutation(getContext: () => ApplierContext) {
  return {
    async classifyEditedFileTransition(
      filePath: string,
      beforeContent: string | null,
      afterContent: string | null
    ): Promise<ReviewFileTransitionState> {
      const ctx = getContext();
      return withFileMutationLock(filePath, async () => {
        const resumedTransaction =
          beforeContent === null
            ? null
            : await ctx.io.resumePreparedReviewFileTransaction({
                kind: afterContent === null ? 'delete' : 'replace',
                sourcePath: filePath,
                targetPath: filePath,
                expectedContent: beforeContent,
                nextContent: afterContent,
              });
        const ownsPublishedTarget = resumedTransaction
          ? (await ctx.io.inspectReviewFileTransaction(resumedTransaction)) === 'published'
          : false;
        if (resumedTransaction && !ownsPublishedTarget) {
          throw new Error('Review file transaction evidence is unavailable or conflicted');
        }
        const current = await ctx.readCurrentText(filePath);
        const currentError = getCurrentTextReadError(current);
        if (currentError) throw new Error(currentError);
        if (!current.missing && !ownsPublishedTarget) {
          await ctx.assertSafeExpectedFile(filePath, current.content);
        }

        const beforeMatches =
          beforeContent === null
            ? current.missing
            : !current.missing && current.content === beforeContent;
        const afterMatches =
          afterContent === null
            ? current.missing
            : !current.missing && current.content === afterContent;
        if (beforeMatches && afterMatches) return 'both';
        if (beforeMatches) return 'before';
        if (afterMatches) return 'after';
        throw new Error('File changed since review update; durable mutation state is ambiguous');
      });
    },
    async saveEditedFile(
      filePath: string,
      content: string,
      expectedCurrentContent: string | null
    ): Promise<{ success: boolean }> {
      const ctx = getContext();
      return withFileMutationLock(filePath, async () => {
        if (expectedCurrentContent !== null) {
          await ctx.io.resumePreparedReviewFileTransaction({
            kind: 'replace',
            sourcePath: filePath,
            targetPath: filePath,
            expectedContent: expectedCurrentContent,
            nextContent: content,
          });
        }
        const current = await ctx.readCurrentText(filePath);
        const currentError = getCurrentTextReadError(current);
        if (currentError) {
          throw new Error(currentError);
        }
        if (expectedCurrentContent !== null && !current.missing && current.content === content) {
          // Idempotent retry after an atomic replacement succeeded but its IPC response
          // was lost. Missing-file restoration intentionally stays non-idempotent because
          // an identical file may have been created independently and must not be claimed.
          return { success: true };
        }
        const matchesExpected =
          expectedCurrentContent === null
            ? current.missing
            : !current.missing && current.content === expectedCurrentContent;
        if (!matchesExpected) {
          throw new Error('File changed since review update; refusing to overwrite');
        }
        if (expectedCurrentContent === null) {
          try {
            await ctx.io.atomicCreateAsync(filePath, content);
          } catch (error) {
            const code =
              error && typeof error === 'object' && 'code' in error
                ? String((error as { code?: unknown }).code)
                : '';
            if (code === 'EEXIST') {
              throw new Error('File changed since review update; refusing to overwrite');
            }
            throw error;
          }
          return { success: true };
        }
        await ctx.atomicReplaceTextFile(filePath, expectedCurrentContent, content);
        return { success: true };
      });
    },
    async deleteEditedFile(
      filePath: string,
      expectedCurrentContent: string
    ): Promise<{ success: boolean }> {
      const ctx = getContext();
      return withFileMutationLock(filePath, async () => {
        await ctx.io.resumePreparedReviewFileTransaction({
          kind: 'delete',
          sourcePath: filePath,
          targetPath: filePath,
          expectedContent: expectedCurrentContent,
          nextContent: null,
        });
        const current = await ctx.readCurrentText(filePath);
        const currentError = getCurrentTextReadError(current);
        if (currentError) throw new Error(currentError);
        if (current.missing) {
          // Idempotent retry after a successful delete whose IPC response was lost.
          return { success: true };
        }
        if (current.content !== expectedCurrentContent) {
          throw new Error('File changed since review update; refusing to delete');
        }
        await ctx.deleteExpectedTextFile(filePath, expectedCurrentContent);
        return { success: true };
      });
    },
    async readCurrentText(filePath: string): Promise<CurrentTextReadResult> {
      let result: CurrentTextReadResult;
      try {
        result = { missing: false, content: await readFile(filePath, 'utf8') };
      } catch (err) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: unknown }).code)
            : '';
        if (code === 'ENOENT') {
          result = { missing: true, content: '' };
        } else {
          result = {
            missing: false,
            content: '',
            error: `Не удалось прочитать файл: ${String(err)}`,
          };
        }
      }
      const context = reviewApplyMutationContext.getStore();
      if (context && !('error' in result) && !context.observedPreimages.has(filePath)) {
        const content = result.missing ? null : result.content;
        context.observedPreimages.set(filePath, {
          filePath,
          beforeContent: content,
          afterContent: content,
        });
      }
      return result;
    },
    getReviewFileTransactionFromTransition,
    async resumeInitialReviewFileTransactions(context: ReviewApplyMutationContext): Promise<void> {
      const ctx = getContext();
      for (const transition of context.plannedTransitions.values()) {
        const transaction = ctx.getReviewFileTransactionFromTransition(transition);
        if (!transaction) continue;
        const state = await ctx.io.inspectReviewFileTransaction(transaction);
        if (state === 'missing' || state === 'conflict') {
          throw new Error('Review file transaction evidence is unavailable or conflicted');
        }
        if (state !== 'published') {
          await context.hooks?.checkpointDiskTransitions([...context.plannedTransitions.values()]);
          await ctx.io.executeReviewFileTransaction(transaction);
        }
      }
    },
    async finalizeReviewDiskTransitions(
      transitions: readonly ApplyReviewDiskTransition[]
    ): Promise<void> {
      const ctx = getContext();
      for (const transition of transitions) {
        const transaction = ctx.getReviewFileTransactionFromTransition(transition);
        if (transaction) await ctx.io.finalizeReviewFileTransaction(transaction);
      }
    },
    async finalizeEditedFileTransaction(
      filePath: string,
      expectedContent: string | null,
      nextContent: string | null
    ): Promise<void> {
      const ctx = getContext();
      if (expectedContent === null) return;
      await ctx.io.finalizePreparedReviewFileTransaction({
        kind: nextContent === null ? 'delete' : 'replace',
        sourcePath: filePath,
        targetPath: filePath,
        expectedContent,
        nextContent,
      });
    },
    async finalizeRejectedRenameTransaction(
      filePath: string,
      original: string | null,
      modified: string | null,
      snippets: SnippetDiff[],
      direction: 'restore' | 'reapply'
    ): Promise<void> {
      const ctx = getContext();
      const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
      const relation = ctx.resolveLedgerRelation(ledgerSnippets);
      if (relation?.kind !== 'rename') return;
      const oldSnippet =
        ledgerSnippets.find(
          (snippet) =>
            snippet.ledger?.operation === 'delete' &&
            ctx.pathMatchesRelationPath(snippet.filePath, relation.oldPath)
        ) ?? ledgerSnippets.find((snippet) => snippet.ledger?.operation === 'delete');
      const newSnippet =
        ledgerSnippets.find(
          (snippet) =>
            snippet.ledger?.operation === 'create' &&
            ctx.pathMatchesRelationPath(snippet.filePath, relation.newPath)
        ) ?? ledgerSnippets.find((snippet) => snippet.ledger?.operation === 'create');
      const oldFilePath =
        oldSnippet?.filePath ??
        ctx.resolveRelatedLedgerPath(newSnippet?.filePath, relation.newPath, relation.oldPath);
      const newFilePath = newSnippet?.filePath ?? filePath;
      const oldContent = oldSnippet?.ledger?.originalFullContent ?? original;
      const newContent = newSnippet?.ledger?.modifiedFullContent ?? modified;
      if (!oldFilePath || oldContent === null || newContent === null) return;
      const sourcePath = direction === 'restore' ? oldFilePath : newFilePath;
      const targetPath = direction === 'restore' ? newFilePath : oldFilePath;
      const expectedContent = direction === 'restore' ? oldContent : newContent;
      const nextContent = direction === 'restore' ? newContent : oldContent;
      if (
        await ctx.io.finalizePreparedReviewFileTransaction({
          kind: 'move',
          sourcePath,
          targetPath,
          expectedContent,
          nextContent,
        })
      ) {
        return;
      }
      await ctx.io.finalizePreparedReviewFileTransaction({
        kind: 'replace',
        sourcePath: targetPath,
        targetPath,
        expectedContent,
        nextContent,
      });
      if (direction === 'reapply') {
        await ctx.io.finalizePreparedReviewFileTransaction({
          kind: 'delete',
          sourcePath: newFilePath,
          targetPath: newFilePath,
          expectedContent: newContent,
          nextContent: null,
        });
      }
    },
    async checkpointPlannedDiskTransition(transition: ApplyReviewDiskTransition): Promise<void> {
      const context = reviewApplyMutationContext.getStore();
      if (!context) return;
      const existing = context.plannedTransitions.get(transition.filePath);
      const cumulative = existing
        ? {
            ...existing,
            filePath: transition.filePath,
            beforeContent: existing.beforeContent,
            afterContent: transition.afterContent,
            ...(transition.operation === undefined ? {} : { operation: transition.operation }),
            ...(transition.transactionId === undefined
              ? {}
              : { transactionId: transition.transactionId }),
            ...(transition.relatedFilePath === undefined
              ? {}
              : { relatedFilePath: transition.relatedFilePath }),
          }
        : transition;
      context.plannedTransitions.set(transition.filePath, cumulative);
      await context.hooks?.checkpointDiskTransitions([...context.plannedTransitions.values()]);
    },
    async atomicReplaceTextFile(
      filePath: string,
      expectedCurrentContent: string,
      nextContent: string
    ): Promise<void> {
      const ctx = getContext();
      const initial = await ctx.assertSafeExpectedFile(filePath, expectedCurrentContent);
      const transaction = await ctx.io.prepareReviewFileTransaction(
        {
          kind: 'replace',
          sourcePath: filePath,
          targetPath: filePath,
          expectedContent: expectedCurrentContent,
          nextContent,
        },
        { mode: initial.mode & 0o7777 }
      );
      const transition: ApplyReviewDiskTransition = {
        filePath,
        beforeContent: expectedCurrentContent,
        afterContent: nextContent,
        operation: 'replace',
        transactionId: transaction.id,
      };
      await ctx.checkpointPlannedDiskTransition(transition);
      await ctx.io.executeReviewFileTransaction(transaction, { expectedIdentity: initial });
    },
    async moveExpectedTextFile(
      sourcePath: string,
      targetPath: string,
      expectedSourceContent: string,
      finalTargetContent: string
    ): Promise<void> {
      const ctx = getContext();
      const initial = await ctx.assertSafeExpectedFile(sourcePath, expectedSourceContent);
      const transaction = await ctx.io.prepareReviewFileTransaction(
        {
          kind: 'move',
          sourcePath,
          targetPath,
          expectedContent: expectedSourceContent,
          nextContent: finalTargetContent,
        },
        { mode: initial.mode & 0o7777 }
      );
      await ctx.checkpointPlannedDiskTransition({
        filePath: sourcePath,
        beforeContent: expectedSourceContent,
        afterContent: finalTargetContent,
        operation: 'move',
        transactionId: transaction.id,
        relatedFilePath: targetPath,
      });
      await ctx.io.executeReviewFileTransaction(transaction, { expectedIdentity: initial });
    },
    async assertSafeExpectedFile(
      filePath: string,
      expectedCurrentContent: string
    ): Promise<{ dev: number; ino: number; mode: number }> {
      const ctx = getContext();
      let stats;
      try {
        stats = await lstat(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          throw Object.assign(
            new Error('File changed during review update; refusing to overwrite'),
            {
              code,
            }
          );
        }
        throw error;
      }
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
        throw new Error('Review mutation refuses symbolic or multiply-linked files');
      }
      const current = await ctx.readCurrentText(filePath);
      const currentError = getCurrentTextReadError(current);
      if (current.missing || currentError || current.content !== expectedCurrentContent) {
        throw new Error(currentError ?? 'File changed during review update; refusing to overwrite');
      }
      return { dev: stats.dev, ino: stats.ino, mode: stats.mode };
    },
    async deleteExpectedTextFile(filePath: string, expectedCurrentContent: string): Promise<void> {
      const ctx = getContext();
      const initial = await ctx.assertSafeExpectedFile(filePath, expectedCurrentContent);
      const transaction = await ctx.io.prepareReviewFileTransaction({
        kind: 'delete',
        sourcePath: filePath,
        targetPath: filePath,
        expectedContent: expectedCurrentContent,
        nextContent: null,
      });
      await ctx.checkpointPlannedDiskTransition({
        filePath,
        beforeContent: expectedCurrentContent,
        afterContent: null,
        operation: 'delete',
        transactionId: transaction.id,
      });
      await ctx.io.executeReviewFileTransaction(transaction, { expectedIdentity: initial });
    },
    async pathsReferToSameFile(firstPath: string, secondPath: string): Promise<boolean> {
      if (firstPath === secondPath) return true;

      const firstNormalized = normalizePathForComparison(firstPath).normalize('NFC');
      const secondNormalized = normalizePathForComparison(secondPath).normalize('NFC');
      if (firstNormalized.toLowerCase() !== secondNormalized.toLowerCase()) {
        // Equal inode alone can mean an arbitrary hardlink, not a case-only rename alias.
        return false;
      }

      try {
        const [first, second] = await Promise.all([lstat(firstPath), lstat(secondPath)]);
        return Boolean(
          first && second && first.ino !== 0 && first.ino === second.ino && first.dev === second.dev
        );
      } catch {
        return false;
      }
    },
    hashText(content: string): string {
      return createHash('sha256').update(content).digest('hex');
    },
  };
}
