import { isWindowsishPath, normalizePathForComparison } from '@shared/utils/platformPath';

import type { FileChangeSummary, HunkDecision } from '@shared/types';

function normalizeReviewPath(filePath: string, forceCaseInsensitive = false): string {
  const normalized = normalizePathForComparison(filePath);
  return forceCaseInsensitive || isWindowsReviewPath(filePath)
    ? normalized.toLowerCase()
    : normalized;
}

function isWindowsReviewPath(filePath: string): boolean {
  return isWindowsishPath(filePath) || filePath.includes('\\');
}

function normalizeReviewAlias(alias: string, forceCaseInsensitive = false): string {
  const slashNormalized = alias.replace(/\\/g, '/');
  const caseInsensitive = forceCaseInsensitive || alias.includes('\\');
  const relationMatch = /^(rename|copy):(.+)->(.+)$/.exec(slashNormalized);
  if (relationMatch) {
    const oldPath = normalizeReviewPath(relationMatch[2] ?? '', caseInsensitive);
    const newPath = normalizeReviewPath(relationMatch[3] ?? '', caseInsensitive);
    return `${relationMatch[1]}:${oldPath}->${newPath}`;
  }
  const pathKeyMatch = /^(path|create|delete):(.+)$/.exec(slashNormalized);
  if (pathKeyMatch) {
    return `${pathKeyMatch[1]}:${normalizeReviewPath(pathKeyMatch[2] ?? '', caseInsensitive)}`;
  }
  return normalizeReviewPath(alias, caseInsensitive);
}

export function getFileReviewKey(file: Pick<FileChangeSummary, 'filePath' | 'changeKey'>): string {
  return file.changeKey ?? file.filePath;
}

export function getReviewKeyForFilePath(
  files: readonly Pick<FileChangeSummary, 'filePath' | 'changeKey'>[] | null | undefined,
  filePath: string
): string {
  const file = files?.find((candidate) => reviewPathsEqual(candidate.filePath, filePath));
  return file ? getFileReviewKey(file) : filePath;
}

function reviewPathsEqual(left: string, right: string): boolean {
  const caseInsensitive = isWindowsReviewPath(left) || isWindowsReviewPath(right);
  return normalizeReviewPath(left, caseInsensitive) === normalizeReviewPath(right, caseInsensitive);
}

export function buildHunkDecisionKey(reviewKey: string, index: number): string {
  return `${reviewKey}:${index}`;
}

export function parseHunkDecisionKey(key: string): { reviewKey: string; index: number } | null {
  const match = /^(.*):(\d+)$/.exec(key);
  if (!match) {
    return null;
  }
  return {
    reviewKey: match[1] ?? '',
    index: Number.parseInt(match[2] ?? '', 10),
  };
}

export function normalizePersistedReviewState(
  files: readonly Pick<FileChangeSummary, 'filePath' | 'changeKey'>[],
  state: {
    fileDecisions?: Record<string, HunkDecision>;
    hunkDecisions?: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
  }
): {
  fileDecisions: Record<string, HunkDecision>;
  hunkDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile: Record<string, Record<number, string>>;
} {
  const reviewKeyByAlias = new Map<string, string>();
  const caseInsensitiveAliases = new Set<string>();
  const addAlias = (alias: string, reviewKey: string, forceCaseInsensitive = false): void => {
    reviewKeyByAlias.set(alias, reviewKey);
    const normalized = normalizeReviewAlias(alias, forceCaseInsensitive);
    reviewKeyByAlias.set(normalized, reviewKey);
    if (forceCaseInsensitive) {
      caseInsensitiveAliases.add(normalized);
    }
  };
  const resolveReviewKey = (alias: string): string | undefined => {
    const caseInsensitiveAlias = normalizeReviewAlias(alias, true);
    return (
      reviewKeyByAlias.get(alias) ??
      reviewKeyByAlias.get(normalizeReviewAlias(alias)) ??
      (caseInsensitiveAliases.has(caseInsensitiveAlias)
        ? reviewKeyByAlias.get(caseInsensitiveAlias)
        : undefined)
    );
  };
  for (const file of files) {
    const reviewKey = getFileReviewKey(file);
    const forceCaseInsensitive = isWindowsReviewPath(file.filePath);
    addAlias(reviewKey, reviewKey, forceCaseInsensitive);
    addAlias(file.filePath, reviewKey, forceCaseInsensitive);
  }

  const fileDecisions: Record<string, HunkDecision> = {};
  for (const [key, decision] of Object.entries(state.fileDecisions ?? {})) {
    const reviewKey = resolveReviewKey(key);
    if (reviewKey) {
      fileDecisions[reviewKey] = decision;
    }
  }

  const hunkDecisions: Record<string, HunkDecision> = {};
  for (const [key, decision] of Object.entries(state.hunkDecisions ?? {})) {
    const parsed = parseHunkDecisionKey(key);
    if (!parsed) {
      continue;
    }
    const reviewKey = resolveReviewKey(parsed.reviewKey);
    if (reviewKey) {
      hunkDecisions[buildHunkDecisionKey(reviewKey, parsed.index)] = decision;
    }
  }

  const hunkContextHashesByFile: Record<string, Record<number, string>> = {};
  for (const [key, hashes] of Object.entries(state.hunkContextHashesByFile ?? {})) {
    const reviewKey = resolveReviewKey(key);
    if (reviewKey) {
      hunkContextHashesByFile[reviewKey] = hashes;
    }
  }

  return { fileDecisions, hunkDecisions, hunkContextHashesByFile };
}
