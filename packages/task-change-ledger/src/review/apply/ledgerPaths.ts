import { isWindowsishPath, normalizePathForComparison } from '../../platformPath.js';
import type { LedgerChangeRelation, SnippetDiff } from '../../contracts.js';
import {
  type LedgerApplyOutcome,
  getCurrentTextReadError,
  type ApplierContext,
} from './applyContext.js';

export function createLedgerPaths(getContext: () => ApplierContext) {
  return {
    resolveLedgerOperation(snippets: SnippetDiff[]): 'create' | 'modify' | 'delete' {
      const ledgerSnippets = snippets.filter((snippet) => snippet.ledger);
      const firstLedger = ledgerSnippets[0]?.ledger;
      const lastLedger = ledgerSnippets[ledgerSnippets.length - 1]?.ledger;
      const baselineExists = firstLedger?.beforeState?.exists;
      const finalExists = lastLedger?.afterState?.exists;

      if (baselineExists === false && finalExists === true) return 'create';
      if (baselineExists === true && finalExists === false) return 'delete';
      if (baselineExists === true && finalExists === true) return 'modify';
      if (baselineExists === false && finalExists === false) return 'create';

      if (lastLedger?.operation === 'delete') return 'delete';
      if (firstLedger?.operation === 'create') return 'create';
      return 'modify';
    },
    resolveLedgerRelation(snippets: SnippetDiff[]): LedgerChangeRelation | undefined {
      return snippets.find((snippet) => snippet.ledger?.relation)?.ledger?.relation;
    },
    resolveLedgerMutationPaths(filePath: string, snippets: SnippetDiff[]): string[] {
      const ctx = getContext();
      const paths = new Set<string>([filePath]);
      for (const snippet of snippets) {
        paths.add(snippet.filePath);
      }

      const relation = ctx.resolveLedgerRelation(snippets);
      if (relation?.kind === 'rename') {
        const newSnippet = snippets.find(
          (snippet) =>
            snippet.ledger?.operation === 'create' &&
            ctx.pathMatchesRelationPath(snippet.filePath, relation.newPath)
        );
        const oldSnippet = snippets.find(
          (snippet) =>
            snippet.ledger?.operation === 'delete' &&
            ctx.pathMatchesRelationPath(snippet.filePath, relation.oldPath)
        );
        const inferredOldPath = ctx.resolveRelatedLedgerPath(
          newSnippet?.filePath,
          relation.newPath,
          relation.oldPath
        );
        if (oldSnippet?.filePath) paths.add(oldSnippet.filePath);
        if (inferredOldPath) paths.add(inferredOldPath);
      }

      return [...paths];
    },
    pathMatchesRelationPath(filePath: string, relationPath: string): boolean {
      const ctx = getContext();
      const caseInsensitive =
        ctx.isWindowsReviewPath(filePath) || ctx.isWindowsReviewPath(relationPath);
      const normalizedFilePath = ctx.normalizeRelationComparisonPath(filePath, caseInsensitive);
      const normalizedRelationPath = ctx.normalizeRelationComparisonPath(
        relationPath,
        caseInsensitive
      );
      return (
        normalizedFilePath === normalizedRelationPath ||
        normalizedFilePath.endsWith(`/${normalizedRelationPath}`)
      );
    },
    resolveRelatedLedgerPath(
      anchorPath: string | undefined,
      anchorRelationPath: string,
      targetRelationPath: string
    ): string | null {
      const ctx = getContext();
      if (!anchorPath) {
        return null;
      }
      const slashAnchor = anchorPath.replace(/\\/g, '/');
      const slashRelation = anchorRelationPath.replace(/\\/g, '/');
      const caseInsensitive =
        ctx.isWindowsReviewPath(anchorPath) || ctx.isWindowsReviewPath(anchorRelationPath);
      const normalizedAnchor = ctx.normalizeRelationComparisonPath(anchorPath, caseInsensitive);
      const normalizedRelation = ctx.normalizeRelationComparisonPath(
        anchorRelationPath,
        caseInsensitive
      );
      if (!ctx.matchesRelationSuffix(normalizedAnchor, normalizedRelation)) {
        return null;
      }
      return `${slashAnchor.slice(0, slashAnchor.length - slashRelation.length)}${targetRelationPath.replace(/\\/g, '/')}`;
    },
    normalizeRelationComparisonPath(filePath: string, caseInsensitive: boolean): string {
      const normalized = normalizePathForComparison(filePath);
      return caseInsensitive ? normalized.toLowerCase() : normalized;
    },
    isWindowsReviewPath(filePath: string): boolean {
      return isWindowsishPath(filePath) || filePath.includes('\\');
    },
    matchesRelationSuffix(normalizedPath: string, normalizedRelationPath: string): boolean {
      return (
        normalizedPath === normalizedRelationPath ||
        normalizedPath.endsWith(`/${normalizedRelationPath}`)
      );
    },
    async checkLedgerCurrentHash(
      filePath: string,
      expectedHash: string | undefined
    ): Promise<{ ok: true } | { ok: false; outcome: LedgerApplyOutcome }> {
      const ctx = getContext();
      if (!expectedHash) {
        return {
          ok: false,
          outcome: {
            handled: true,
            status: 'error',
            code: 'manual-review-required',
            error: 'Ledger expected content hash is unavailable; refusing automatic apply.',
          },
        };
      }
      const current = await ctx.readCurrentText(filePath);
      if (current.missing) {
        return {
          ok: false,
          outcome: {
            handled: true,
            status: 'conflict',
            code: 'conflict',
            error: 'File is missing on disk; refusing ledger apply.',
          },
        };
      }
      const currentError = getCurrentTextReadError(current);
      if (currentError) {
        return {
          ok: false,
          outcome: {
            handled: true,
            status: 'error',
            code: 'io-error',
            error: currentError,
          },
        };
      }
      if (ctx.hashText(current.content) !== expectedHash) {
        return {
          ok: false,
          outcome: {
            handled: true,
            status: 'conflict',
            code: 'conflict',
            error: 'File was modified since review was computed; refusing ledger apply.',
          },
        };
      }
      return { ok: true };
    },
  };
}
