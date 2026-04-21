import type { FileChangeSummary, HunkDecision } from '@shared/types';
import { normalizePathForComparison } from '@shared/utils/platformPath';

function normalizeReviewAlias(alias: string): string {
  const slashNormalized = alias.replace(/\\/g, '/');
  const relationMatch = /^(rename|copy):(.+)->(.+)$/.exec(slashNormalized);
  if (relationMatch) {
    return `${relationMatch[1]}:${normalizePathForComparison(relationMatch[2] ?? '')}->${normalizePathForComparison(relationMatch[3] ?? '')}`;
  }
  const pathKeyMatch = /^(path|create|delete):(.+)$/.exec(slashNormalized);
  if (pathKeyMatch) {
    return `${pathKeyMatch[1]}:${normalizePathForComparison(pathKeyMatch[2] ?? '')}`;
  }
  return normalizePathForComparison(alias);
}

export function getFileReviewKey(
  file: Pick<FileChangeSummary, 'filePath' | 'changeKey'>
): string {
  return file.changeKey ?? file.filePath;
}

export function getReviewKeyForFilePath(
  files: readonly Pick<FileChangeSummary, 'filePath' | 'changeKey'>[] | null | undefined,
  filePath: string
): string {
  const normalizedFilePath = normalizePathForComparison(filePath);
  const file = files?.find(
    (candidate) => normalizePathForComparison(candidate.filePath) === normalizedFilePath
  );
  return file ? getFileReviewKey(file) : filePath;
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
  const addAlias = (alias: string, reviewKey: string): void => {
    reviewKeyByAlias.set(alias, reviewKey);
    reviewKeyByAlias.set(normalizeReviewAlias(alias), reviewKey);
  };
  const resolveReviewKey = (alias: string): string | undefined => {
    return reviewKeyByAlias.get(alias) ?? reviewKeyByAlias.get(normalizeReviewAlias(alias));
  };
  for (const file of files) {
    const reviewKey = getFileReviewKey(file);
    addAlias(reviewKey, reviewKey);
    addAlias(file.filePath, reviewKey);
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
