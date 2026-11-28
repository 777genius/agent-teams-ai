import type { LedgerChangeRelation, SnippetDiff } from '../../contracts.js';
import {
  type LedgerApplyOutcome,
  getCurrentTextReadError,
  type ApplierContext,
} from './applyContext.js';

export function createLedgerPaths(getContext: () => ApplierContext) {
  return {
    resolveLedgerRenameEndpoints(
      snippets: SnippetDiff[],
      relation: LedgerChangeRelation
    ): {
      oldSnippet: SnippetDiff | undefined;
      newSnippet: SnippetDiff;
      oldFilePath: string;
      newFilePath: string;
    } | null {
      const ctx = getContext();
      if (relation.kind !== 'rename' || !snippets.length) return null;
      const sameRelation = (snippet: SnippetDiff): boolean => {
        const candidate = snippet.ledger?.relation;
        return (
          candidate?.kind === 'rename' &&
          ctx.normalizeRelationComparisonPath(candidate.oldPath) ===
            ctx.normalizeRelationComparisonPath(relation.oldPath) &&
          ctx.normalizeRelationComparisonPath(candidate.newPath) ===
            ctx.normalizeRelationComparisonPath(relation.newPath)
        );
      };
      if (!snippets.every(sameRelation)) return null;
      const oldCandidates = snippets.filter((snippet) => snippet.ledger?.operation === 'delete');
      const newCandidates = snippets.filter((snippet) => snippet.ledger?.operation === 'create');
      if (
        newCandidates.length !== 1 ||
        oldCandidates.length > 1 ||
        oldCandidates.length + newCandidates.length !== snippets.length
      )
        return null;
      const newSnippet = newCandidates[0];
      const oldSnippet = oldCandidates[0];
      if (
        !ctx.pathMatchesRelationPath(newSnippet.filePath, relation.newPath) ||
        (oldSnippet && !ctx.pathMatchesRelationPath(oldSnippet.filePath, relation.oldPath))
      )
        return null;
      const oldFilePath =
        oldSnippet?.filePath ??
        ctx.resolveRelatedLedgerPath(newSnippet.filePath, relation.newPath, relation.oldPath);
      if (!oldFilePath) return null;
      return { oldSnippet, newSnippet, oldFilePath, newFilePath: newSnippet.filePath };
    },

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
        const endpoints = ctx.resolveLedgerRenameEndpoints(snippets, relation);
        if (endpoints) paths.add(endpoints.oldFilePath);
      }

      return [...paths];
    },
    pathMatchesRelationPath(filePath: string, relationPath: string): boolean {
      const ctx = getContext();
      return ctx.matchesRelationSuffix(
        ctx.normalizeRelationComparisonPath(filePath),
        ctx.normalizeRelationComparisonPath(relationPath)
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
      const normalizedAnchor = ctx.normalizeRelationComparisonPath(anchorPath);
      const normalizedRelation = ctx.normalizeRelationComparisonPath(anchorRelationPath);
      if (!ctx.matchesRelationSuffix(normalizedAnchor, normalizedRelation)) {
        return null;
      }
      return `${slashAnchor.slice(0, slashAnchor.length - slashRelation.length)}${targetRelationPath.replace(/\\/g, '/')}`;
    },
    normalizeRelationComparisonPath(filePath: string): string {
      return filePath.replace(/\\/g, '/');
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
