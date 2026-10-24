import * as path from 'node:path';
import type { LedgerChangeRelation, SnippetDiff } from './contracts.js';
import type { LedgerSummaryFileV2 } from './ledgerTypes.js';
import { isWindowsishPath, normalizePathForComparison } from './platformPath.js';

export function normalizeSummaryChangeKey(file: LedgerSummaryFileV2): string {
  if (file.relation) {
    return relationChangeKey(file.relation, file.worktreePath);
  }
  const slashNormalized = file.changeKey.replace(/\\/g, '/');
  const pathKeyMatch = /^(path|create|delete):(.+)$/.exec(slashNormalized);
  if (pathKeyMatch) {
    return `${pathKeyMatch[1]}:${normalizePathForComparison(pathKeyMatch[2] ?? '')}`;
  }
  return slashNormalized;
}

export function groupKeyForSnippet(snippet: SnippetDiff): string {
  return groupKeyForFileSummary(
    snippet.filePath,
    snippet.ledger?.relation,
    snippet.ledger?.worktreePath
  );
}

export function groupKeyForFileSummary(
  filePath: string,
  relation?: LedgerChangeRelation,
  worktreePath?: string
): string {
  if (relation) {
    return relationChangeKey(relation, worktreePath);
  }
  return `path:${normalizePathForComparison(filePath)}`;
}

export function relationChangeKey(relation: LedgerChangeRelation, worktreePath?: string): string {
  const pathPart = `${normalizePathForComparison(relation.oldPath)}->${normalizePathForComparison(relation.newPath)}`;
  return worktreePath
    ? `${relation.kind}:${normalizePathForComparison(worktreePath)}:${pathPart}`
    : `${relation.kind}:${pathPart}`;
}

export function relationForSnippets(snippets: SnippetDiff[]): LedgerChangeRelation | undefined {
  return snippets.find((snippet) => snippet.ledger?.relation)?.ledger?.relation;
}

export function resolveGroupedDisplayPath(
  fallbackPath: string,
  relation: LedgerChangeRelation | undefined,
  snippets: SnippetDiff[]
): string {
  if (!relation) {
    return fallbackPath;
  }

  const newPathSnippet = snippets.find((snippet) =>
    pathMatchesRelationPath(snippet.filePath, relation.newPath)
  );
  if (newPathSnippet) {
    return newPathSnippet.filePath;
  }

  const createdSnippet = snippets.find(
    (snippet) => snippet.ledger?.operation === 'create' || snippet.type === 'write-new'
  );
  if (createdSnippet) {
    return createdSnippet.filePath;
  }

  return (
    resolveRelatedPathFromRelation(fallbackPath, relation.oldPath, relation.newPath) ?? fallbackPath
  );
}

export function pathMatchesRelationPath(filePath: string, relationPath: string): boolean {
  const caseInsensitive = isWindowsReviewPath(filePath) || isWindowsReviewPath(relationPath);
  const normalizedFilePath = normalizeRelationComparisonPath(filePath, caseInsensitive);
  const normalizedRelationPath = normalizeRelationComparisonPath(relationPath, caseInsensitive);
  return (
    normalizedFilePath === normalizedRelationPath ||
    normalizedFilePath.endsWith(`/${normalizedRelationPath}`)
  );
}

export function resolveRelatedPathFromRelation(
  anchorPath: string,
  anchorRelationPath: string,
  targetRelationPath: string
): string | null {
  const slashAnchor = anchorPath.replace(/\\/g, '/');
  const slashAnchorRelation = anchorRelationPath.replace(/\\/g, '/');
  const caseInsensitive =
    isWindowsReviewPath(anchorPath) || isWindowsReviewPath(anchorRelationPath);
  const normalizedAnchor = normalizeRelationComparisonPath(anchorPath, caseInsensitive);
  const normalizedAnchorRelation = normalizeRelationComparisonPath(
    anchorRelationPath,
    caseInsensitive
  );
  if (!matchesRelationSuffix(normalizedAnchor, normalizedAnchorRelation)) {
    return null;
  }

  return normalizeLedgerFilePath(
    `${slashAnchor.slice(0, slashAnchor.length - slashAnchorRelation.length)}${targetRelationPath.replace(/\\/g, '/')}`
  );
}

export function normalizeRelationComparisonPath(
  filePath: string,
  caseInsensitive: boolean
): string {
  const normalized = normalizePathForComparison(filePath);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function isWindowsReviewPath(filePath: string): boolean {
  return isWindowsishPath(filePath) || filePath.includes('\\');
}

export function matchesRelationSuffix(
  normalizedPath: string,
  normalizedRelationPath: string
): boolean {
  return (
    normalizedPath === normalizedRelationPath ||
    normalizedPath.endsWith(`/${normalizedRelationPath}`)
  );
}

export function normalizeLedgerFilePath(filePath: string): string {
  const slashPath = filePath.replace(/\\/g, '/');
  const isWindowsAbsolute = /^[A-Za-z]:\//.test(slashPath) || slashPath.startsWith('//');
  if (isWindowsAbsolute || (process.platform !== 'win32' && path.isAbsolute(filePath))) {
    return path.normalize(filePath);
  }
  return slashPath;
}

export function relativePath(
  filePath: string,
  projectPath?: string,
  explicitRelativePath?: string
): string {
  if (explicitRelativePath) {
    return explicitRelativePath.replace(/\\/g, '/');
  }
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const normalizedProjectPath = projectPath?.replace(/\\/g, '/');
  const comparableFilePath = normalizePathForComparison(normalizedFilePath);
  const comparableProjectPath = normalizedProjectPath
    ? normalizePathForComparison(normalizedProjectPath)
    : undefined;
  if (
    normalizedProjectPath &&
    comparableProjectPath &&
    comparableFilePath.startsWith(`${comparableProjectPath}/`)
  ) {
    return normalizedFilePath.slice(normalizedProjectPath.length + 1);
  }
  return normalizedFilePath.split('/').slice(-3).join('/');
}
