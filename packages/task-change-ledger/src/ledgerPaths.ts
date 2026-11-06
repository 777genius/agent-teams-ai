import * as path from 'node:path';
import type { LedgerChangeRelation, SnippetDiff } from './contracts.js';
import type { LedgerSummaryFileV2 } from './ledgerTypes.js';

export function normalizeSummaryChangeKey(file: LedgerSummaryFileV2): string {
  if (file.relation) {
    return relationChangeKey(file.relation, file.worktreePath);
  }
  const slashNormalized = file.changeKey.replace(/\\/g, '/');
  const pathKeyMatch = /^(path|create|delete):(.+)$/.exec(slashNormalized);
  if (pathKeyMatch) {
    return `${pathKeyMatch[1]}:${pathKeyMatch[2]}`;
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
  return `path:${filePath.replace(/\\/g, '/')}`;
}

export function relationChangeKey(relation: LedgerChangeRelation, worktreePath?: string): string {
  const pathPart = `${relation.oldPath.replace(/\\/g, '/')}->${relation.newPath.replace(/\\/g, '/')}`;
  return worktreePath
    ? `${relation.kind}:${worktreePath.replace(/\\/g, '/')}:${pathPart}`
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
  const normalizedFilePath = filePath.replace(/\\/g, '/');
  const normalizedRelationPath = relationPath.replace(/\\/g, '/');
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
  if (!matchesRelationSuffix(slashAnchor, slashAnchorRelation)) {
    return null;
  }

  return normalizeLedgerFilePath(
    `${slashAnchor.slice(0, slashAnchor.length - slashAnchorRelation.length)}${targetRelationPath.replace(/\\/g, '/')}`
  );
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
  if (normalizedProjectPath && normalizedFilePath.startsWith(`${normalizedProjectPath}/`)) {
    return normalizedFilePath.slice(normalizedProjectPath.length + 1);
  }
  return normalizedFilePath.split('/').slice(-3).join('/');
}
