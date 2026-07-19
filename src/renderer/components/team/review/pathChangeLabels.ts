import { isWindowsishPath, normalizePathForComparison } from '@shared/utils/platformPath';

import { isReviewFileExpectedDeleted } from './reviewContentPreview';

import type { FileChangeSummary, FileChangeWithContent } from '@shared/types';

export type PathChangeLabel =
  | { kind: 'deleted' }
  | { kind: 'copied' | 'moved' | 'renamed'; direction: 'from' | 'to'; otherPath: string };

export function buildPathChangeLabels(
  files: readonly FileChangeSummary[],
  fileContents: Record<string, FileChangeWithContent>
): Record<string, PathChangeLabel> {
  const normalizeText = (s: string): string =>
    s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  const pathMatches = (candidate: string, relationPath: string): boolean => {
    const caseInsensitive = isWindowsReviewPath(candidate) || isWindowsReviewPath(relationPath);
    const normalizedCandidate = normalizeLabelComparisonPath(candidate, caseInsensitive);
    const normalizedRelationPath = normalizeLabelComparisonPath(relationPath, caseInsensitive);
    return (
      normalizedCandidate === normalizedRelationPath ||
      normalizedCandidate.endsWith(`/${normalizedRelationPath}`)
    );
  };
  const hashFull = (s: string): string => {
    // DJB2 (full string), good enough for heuristic rename/move pairing.
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

  const out: Record<string, PathChangeLabel> = {};

  for (const file of files) {
    const relation =
      file.ledgerSummary?.relation ??
      file.snippets.find((snippet) => snippet.ledger?.relation)?.ledger?.relation;
    if (relation) {
      const isOldSide =
        pathMatches(file.relativePath, relation.oldPath) ||
        pathMatches(file.filePath, relation.oldPath);
      const isNewSide =
        pathMatches(file.relativePath, relation.newPath) ||
        pathMatches(file.filePath, relation.newPath);
      if (isOldSide !== isNewSide) {
        const direction: 'from' | 'to' = isOldSide ? 'to' : 'from';
        out[file.filePath] = {
          kind: relation.kind === 'copy' ? 'copied' : 'renamed',
          direction,
          otherPath: direction === 'from' ? relation.oldPath : relation.newPath,
        };
        continue;
      }
    }

    if (isReviewFileExpectedDeleted(file)) {
      out[file.filePath] = { kind: 'deleted' };
    }
  }

  const deletedCandidates: { file: FileChangeSummary; hash: string }[] = [];
  const newCandidates: { file: FileChangeSummary; hash: string }[] = [];

  for (const file of files) {
    if (out[file.filePath]) continue;
    const content = fileContents[file.filePath];
    if (!content) continue;

    const modified = content.modifiedFullContent;
    const original = content.originalFullContent;

    if (!file.isNewFile && modified == null) {
      if (original != null) {
        deletedCandidates.push({ file, hash: hashFull(normalizeText(original)) });
      }
    }

    if (file.isNewFile && modified != null) {
      newCandidates.push({ file, hash: hashFull(normalizeText(modified)) });
    }
  }

  const deletedByHash = new Map<string, { file: FileChangeSummary; count: number }>();
  for (const deleted of deletedCandidates) {
    const prev = deletedByHash.get(deleted.hash);
    deletedByHash.set(deleted.hash, { file: deleted.file, count: (prev?.count ?? 0) + 1 });
  }

  const usedDeleted = new Set<string>();
  for (const nextFile of newCandidates) {
    const entry = deletedByHash.get(nextFile.hash);
    if (!entry) continue;
    if (entry.count !== 1) continue;
    const oldFile = entry.file;
    if (usedDeleted.has(oldFile.filePath)) continue;
    usedDeleted.add(oldFile.filePath);

    const oldName = baseName(oldFile.relativePath);
    const newName = baseName(nextFile.file.relativePath);
    const kind: 'moved' | 'renamed' =
      oldName === newName && oldFile.relativePath !== nextFile.file.relativePath
        ? 'moved'
        : 'renamed';

    out[nextFile.file.filePath] = { kind, direction: 'from', otherPath: oldFile.relativePath };
    out[oldFile.filePath] = { kind, direction: 'to', otherPath: nextFile.file.relativePath };
  }

  for (const deleted of deletedCandidates) {
    if (!usedDeleted.has(deleted.file.filePath) && !(deleted.file.filePath in out)) {
      out[deleted.file.filePath] = { kind: 'deleted' };
    }
  }

  return out;
}

function normalizeLabelComparisonPath(filePath: string, caseInsensitive: boolean): string {
  const normalized = normalizePathForComparison(filePath);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isWindowsReviewPath(filePath: string): boolean {
  return isWindowsishPath(filePath) || filePath.includes('\\');
}
