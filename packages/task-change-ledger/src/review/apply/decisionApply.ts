import { assertReviewReplayEvidence } from './reviewReplayEvidence.js';
import { hasUnqualifiedNativeChain } from '../../nativeCaptureProof.js';
import { threeWayTextMerge } from './threeWayTextMerge.js';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import type {
  ApplyReviewRequest,
  ApplyReviewResult,
  FileChangeWithContent,
  SnippetDiff,
} from '../../contracts.js';
import {
  type ReviewApplyMutationHooks,
  type ReviewApplyMutationContext,
  reviewApplyMutationContext,
  type LedgerApplyOutcome,
  getCurrentTextReadError,
  withFileMutationLocks,
  mapRejectedHunkIndicesByHashStrict,
  type ApplierContext,
} from './applyContext.js';

export function createDecisionApply(getContext: () => ApplierContext) {
  return {
    async applyReviewDecisions(
      request: ApplyReviewRequest,
      fileContents = new Map<string, FileChangeWithContent>(),
      hooks?: ReviewApplyMutationHooks
    ): Promise<ApplyReviewResult> {
      const ctx = getContext();
      const context: ReviewApplyMutationContext = {
        hooks,
        observedPreimages: new Map(),
        plannedTransitions: new Map(
          (hooks?.initialDiskTransitions ?? []).map((transition) => [transition.filePath, transition])
        ),
      };
      return reviewApplyMutationContext.run(context, async () => {
        assertReviewReplayEvidence(request, fileContents, hooks?.initialDiskTransitions ?? []);
        if (hooks?.initialDiskTransitions?.length) {
          const renameEndpoints: { oldFilePath: string; newFilePath: string }[] = [];
          for (const change of fileContents.values()) {
            const ledgerSnippets = change.snippets.filter(
              (snippet) => snippet.ledger && !snippet.isError
            );
            const relation = ctx.resolveLedgerRelation(ledgerSnippets);
            if (relation?.kind === 'rename') {
              const endpoints = ctx.resolveLedgerRenameEndpoints(ledgerSnippets, relation);
              if (!endpoints) throw new Error('Ledger rename recovery metadata is incomplete.');
              renameEndpoints.push(endpoints);
            }
          }
          for (const transition of hooks.initialDiskTransitions) {
            if (transition.operation !== 'move') continue;
            const source = ctx.normalizeRelationComparisonPath(transition.filePath);
            const target = ctx.normalizeRelationComparisonPath(transition.relatedFilePath ?? '');
            if (
              !renameEndpoints.some((endpoints) => {
                const oldPath = ctx.normalizeRelationComparisonPath(endpoints.oldFilePath);
                const newPath = ctx.normalizeRelationComparisonPath(endpoints.newFilePath);
                return (
                  (source === newPath && target === oldPath) ||
                  (source === oldPath && target === newPath)
                );
              })
            ) {
              throw new Error('Review replay evidence path does not match ledger rename');
            }
          }
        }
        await ctx.resumeInitialReviewFileTransactions(context);
        const result = await ctx.applyReviewDecisionsInContext(request, fileContents);
        const diskTransitions = new Map(context.plannedTransitions);
        for (const [filePath, observed] of context.observedPreimages) {
          if (!diskTransitions.has(filePath)) diskTransitions.set(filePath, observed);
        }
        if (result.errors.length === 0 && diskTransitions.size > 0) {
          await hooks?.checkpointDiskTransitions([...diskTransitions.values()]);
        }
        return result;
      });
    },
    async applyReviewDecisionsInContext(
      request: ApplyReviewRequest,
      fileContents: Map<string, FileChangeWithContent>
    ): Promise<ApplyReviewResult> {
      const ctx = getContext();
      let applied = 0;
      let skipped = 0;
      let conflicts = 0;
      const errors: ApplyReviewResult['errors'] = [];

      for (const decision of request.decisions) {
        const fileContent = fileContents.get(decision.filePath);
        if (!fileContent) {
          skipped++;
          continue;
        }

        if (decision.fileDecision === 'accepted') {
          skipped++;
          continue;
        }

        const original = fileContent.originalFullContent;
        const modified = fileContent.modifiedFullContent;

        const rejectedHunkIndices = Object.entries(decision.hunkDecisions)
          .filter(([, d]) => d === 'rejected')
          .map(([idx]) => parseInt(idx, 10));

        const allHunksRejected =
          Object.keys(decision.hunkDecisions).length > 0 &&
          Object.values(decision.hunkDecisions).every((d) => d === 'rejected');
        const ledgerOutcome = await ctx.tryApplyLedgerDecision(
          decision.filePath,
          original,
          modified,
          decision.fileDecision === 'rejected',
          allHunksRejected,
          rejectedHunkIndices,
          decision.hunkContextHashes,
          fileContent.snippets
        );
        if (ledgerOutcome.handled) {
          if (ledgerOutcome.status === 'applied') {
            applied++;
          } else if (ledgerOutcome.status === 'skipped') {
            skipped++;
          } else if (ledgerOutcome.status === 'conflict' || ledgerOutcome.status === 'error') {
            if (ledgerOutcome.status === 'conflict') conflicts++;
            errors.push({
              filePath: decision.filePath,
              error: ledgerOutcome.error,
              code: ledgerOutcome.code,
            });
          }
          continue;
        }

        // Native snippets have no task-time filesystem identity. Current bytes
        // cannot justify deleting or restoring a file through a mutable path.
        errors.push({
          filePath: decision.filePath,
          error: 'Исходное состояние файла не подтверждено для reject',
          code: 'unavailable',
        });
      }

      return { applied, skipped, conflicts, errors };
    },
    async tryApplyLedgerDecision(
      filePath: string,
      original: string | null,
      modified: string | null,
      fileRejected: boolean,
      allHunksRejected: boolean,
      rejectedHunkIndices: number[],
      hunkContextHashes: Record<number, string> | undefined,
      snippets: SnippetDiff[]
    ): Promise<LedgerApplyOutcome> {
      const ctx = getContext();
      const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
      if (ledgerSnippets.length === 0) {
        return { handled: false };
      }

      return withFileMutationLocks(ctx.resolveLedgerMutationPaths(filePath, ledgerSnippets), () =>
        ctx.tryApplyLedgerDecisionLocked(
          filePath,
          original,
          modified,
          fileRejected,
          allHunksRejected,
          rejectedHunkIndices,
          hunkContextHashes,
          ledgerSnippets
        )
      );
    },
    async tryApplyLedgerDecisionLocked(
      filePath: string,
      original: string | null,
      modified: string | null,
      fileRejected: boolean,
      allHunksRejected: boolean,
      rejectedHunkIndices: number[],
      hunkContextHashes: Record<number, string> | undefined,
      ledgerSnippets: SnippetDiff[]
    ): Promise<LedgerApplyOutcome> {
      const ctx = getContext();
      const firstLedger = ledgerSnippets[0]?.ledger;
      const lastLedger = ledgerSnippets[ledgerSnippets.length - 1]?.ledger;
      if (!firstLedger || !lastLedger) {
        return { handled: false };
      }

      if (hasUnqualifiedNativeChain(ledgerSnippets) ||
        (ledgerSnippets.some((snippet) => snippet.ledger?.nativeCapture) &&
          (original === null || modified === null))) {
        return { handled: true, status: 'error', code: 'manual-review-required',
          error: 'Native file attribution is unqualified; review mutation refused.' };
      }

      const fullReject = fileRejected || allHunksRejected;
      const hasUnavailableState = ledgerSnippets.some(
        (snippet) =>
          snippet.ledger?.beforeState?.unavailableReason ||
          snippet.ledger?.afterState?.unavailableReason
      );
      const relation = ctx.resolveLedgerRelation(ledgerSnippets);

      if (hasUnavailableState) {
        return {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error: 'Ledger content metadata is unavailable; manual review is required.',
        };
      }

      if (!fullReject) {
        if (relation?.kind === 'rename' || relation?.kind === 'copy') {
          return {
            handled: true,
            status: 'error',
            code: 'manual-review-required',
            error: `Ledger ${relation.kind} partial reject requires manual review.`,
          };
        }
        if (original === null || modified === null) {
          return {
            handled: true,
            status: 'error',
            code: 'manual-review-required',
            error: 'Ledger full text is unavailable; partial reject requires manual review.',
          };
        }
        const strictHunks = mapRejectedHunkIndicesByHashStrict(
          original,
          modified,
          rejectedHunkIndices,
          hunkContextHashes
        );
        if (!strictHunks.ok) {
          return {
            handled: true,
            status: strictHunks.code === 'conflict' ? 'conflict' : 'error',
            code: strictHunks.code,
            error: strictHunks.error,
          };
        }
        const patchResult = ctx.tryStrictHunkLevelReject(original, modified, strictHunks.indices);
        if (!patchResult) {
          return {
            handled: true,
            status: 'error',
            code: 'manual-review-required',
            error: 'Ledger partial reject could not be applied safely.',
          };
        }

        const expectedHash = lastLedger.afterState?.sha256 ?? lastLedger.afterHash ?? undefined;
        if (!expectedHash) {
          return {
            handled: true,
            status: 'error',
            code: 'manual-review-required',
            error: 'Ledger expected content hash is unavailable; refusing automatic apply.',
          };
        }
        const current = await ctx.readCurrentText(filePath);
        if (current.missing) {
          return {
            handled: true,
            status: 'conflict',
            code: 'conflict',
            error: 'File is missing on disk; refusing ledger apply.',
          };
        }
        const currentError = getCurrentTextReadError(current);
        if (currentError) {
          return {
            handled: true,
            status: 'error',
            code: 'io-error',
            error: currentError,
          };
        }

        let newContent = patchResult.newContent;
        if (ctx.hashText(current.content) !== expectedHash) {
          const mergeResult = threeWayTextMerge(modified, current.content, patchResult.newContent);
          if (mergeResult.hasConflicts) {
            return {
              handled: true,
              status: 'conflict',
              code: 'conflict',
              error: 'Current file edits conflict with the requested ledger hunk reject.',
            };
          }
          newContent = mergeResult.content;
        }
        if (newContent === current.content) {
          return { handled: true, status: 'applied' };
        }
        try {
          await ctx.atomicReplaceTextFile(filePath, current.content, newContent);
          return { handled: true, status: 'applied' };
        } catch (err) {
          return {
            handled: true,
            status: 'error',
            code: 'io-error',
            error: `Не удалось записать файл: ${String(err)}`,
          };
        }
      }

      if (relation?.kind === 'rename') {
        return ctx.rejectLedgerRename(ledgerSnippets, relation, original, hasUnavailableState);
      }

      const operation = ctx.resolveLedgerOperation(ledgerSnippets);
      if (operation === 'create') {
        const afterHash = lastLedger.afterState?.sha256 ?? lastLedger.afterHash ?? undefined;
        const current = await ctx.readCurrentText(filePath);
        if (current.missing) {
          return { handled: true, status: 'applied' };
        }
        const currentError = getCurrentTextReadError(current);
        if (currentError) {
          return {
            handled: true,
            status: 'error',
            code: 'io-error',
            error: currentError,
          };
        }
        if (!afterHash) {
          return {
            handled: true,
            status: 'error',
            code: hasUnavailableState ? 'manual-review-required' : 'unavailable',
            error:
              'Ledger after content hash is unavailable; refusing to delete file automatically.',
          };
        }
        if (ctx.hashText(current.content) !== afterHash) {
          return {
            handled: true,
            status: 'conflict',
            code: 'conflict',
            error: 'File was modified since review was computed; refusing ledger delete.',
          };
        }
        try {
          await ctx.deleteExpectedTextFile(filePath, current.content);
          return { handled: true, status: 'applied' };
        } catch (err) {
          const msg = String(err);
          if (msg.includes('ENOENT')) {
            return { handled: true, status: 'applied' };
          }
          return {
            handled: true,
            status: 'error',
            code: 'io-error',
            error: `Failed to delete new file: ${msg}`,
          };
        }
      }

      if (operation === 'delete') {
        if (original === null) {
          return {
            handled: true,
            status: 'error',
            code: 'manual-review-required',
            error: 'Ledger before content is unavailable; deleted file requires manual restore.',
          };
        }
        const current = await ctx.readCurrentText(filePath);
        if (!current.missing) {
          const currentError = getCurrentTextReadError(current);
          if (!currentError && current.content === original) {
            return { handled: true, status: 'applied' };
          }
          return {
            handled: true,
            status: 'conflict',
            code: 'conflict',
            error:
              currentError || 'File exists on disk; refusing to overwrite while rejecting delete.',
          };
        }
        try {
          ctx.assertCurrent?.();
          await mkdir(dirname(filePath), { recursive: true });
          await ctx.checkpointPlannedDiskTransition({
            filePath,
            beforeContent: null,
            afterContent: original,
          });
          await ctx.io.atomicCreateAsync(filePath, original);
          return { handled: true, status: 'applied' };
        } catch (err) {
          const code =
            err && typeof err === 'object' && 'code' in err
              ? String((err as { code?: unknown }).code)
              : '';
          return {
            handled: true,
            status: code === 'EEXIST' ? 'conflict' : 'error',
            code: code === 'EEXIST' ? 'conflict' : 'io-error',
            error:
              code === 'EEXIST'
                ? 'Deleted file was recreated while restoring it; refusing overwrite.'
                : `Не удалось записать файл: ${String(err)}`,
          };
        }
      }

      if (original === null) {
        return {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error:
            'Ledger before content is unavailable; rejecting this change requires manual review.',
        };
      }
      const current = await ctx.readCurrentText(filePath);
      const currentError = getCurrentTextReadError(current);
      if (currentError) {
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: currentError,
        };
      }
      if (!current.missing && current.content === original) {
        return { handled: true, status: 'applied' };
      }
      const guard = await ctx.checkLedgerCurrentHash(
        filePath,
        lastLedger.afterState?.sha256 ?? lastLedger.afterHash ?? undefined
      );
      if (!guard.ok) {
        return guard.outcome;
      }
      try {
        await ctx.atomicReplaceTextFile(filePath, current.content, original);
        return { handled: true, status: 'applied' };
      } catch (err) {
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: `Не удалось записать файл: ${String(err)}`,
        };
      }
    },
  };
}
