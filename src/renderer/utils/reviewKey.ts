import { isWindowsishPath } from '@shared/utils/platformPath';

import type { FileChangeSummary, HunkDecision } from '@shared/types';

/** Review identities preserve case because Windows directories may be case-sensitive. */
export function normalizeReviewPathForIdentity(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function normalizeReviewPath(filePath: string, forceCaseInsensitive = false): string {
  const normalized = normalizeReviewPathForIdentity(filePath);
  return forceCaseInsensitive ? normalized.toLowerCase() : normalized;
}

function isWindowsReviewPath(filePath: string): boolean {
  return isWindowsishPath(filePath) || filePath.includes('\\');
}

function normalizeReviewAlias(alias: string, forceCaseInsensitive = false): string {
  const slashNormalized = alias.replace(/\\/g, '/');
  const relationMatch = /^(rename|copy):(.+)->(.+)$/.exec(slashNormalized);
  if (relationMatch) {
    const oldPath = normalizeReviewPath(relationMatch[2] ?? '', forceCaseInsensitive);
    const newPath = normalizeReviewPath(relationMatch[3] ?? '', forceCaseInsensitive);
    return `${relationMatch[1]}:${oldPath}->${newPath}`;
  }
  const pathKeyMatch = /^(path|create|delete):(.+)$/.exec(slashNormalized);
  if (pathKeyMatch) {
    return `${pathKeyMatch[1]}:${normalizeReviewPath(pathKeyMatch[2] ?? '', forceCaseInsensitive)}`;
  }
  return normalizeReviewPath(alias, forceCaseInsensitive);
}

export function getFileReviewKey(file: Pick<FileChangeSummary, 'filePath' | 'changeKey'>): string {
  return file.changeKey ?? file.filePath;
}

export function hasDuplicateReviewFilePaths(
  files: readonly Pick<FileChangeSummary, 'filePath'>[]
): boolean {
  const paths = files.map((file) => normalizeReviewPath(file.filePath));
  return new Set(paths).size !== paths.length;
}

export function getReviewKeyForFilePath(
  files: readonly Pick<FileChangeSummary, 'filePath' | 'changeKey'>[] | null | undefined,
  filePath: string
): string {
  const file = findReviewFileByPath(files, filePath);
  return file ? getFileReviewKey(file) : filePath;
}

/** Use a separate renderer slot only when multiple lifecycle entries share a disk path. */
export function getReviewEntryKey<T extends Pick<FileChangeSummary, 'filePath' | 'changeKey'>>(
  files: readonly T[],
  file: T
): string {
  const path = normalizeReviewPath(file.filePath);
  const siblings = files.filter((entry) => normalizeReviewPath(entry.filePath) === path);
  if (siblings.length === 1) return file.filePath;
  if (
    !file.changeKey ||
    siblings.filter((entry) => entry.changeKey === file.changeKey).length !== 1
  ) {
    throw new Error(`Ambiguous review entries for ${file.filePath}`);
  }
  return file.changeKey;
}

export function findReviewFileByPath<T extends Pick<FileChangeSummary, 'filePath' | 'changeKey'>>(
  files: readonly T[] | null | undefined,
  filePath: string
): T | undefined {
  const exactKey = files?.filter((file) => file.changeKey === filePath);
  if (exactKey?.length === 1) return exactKey[0];
  const exactPath = normalizeReviewPath(filePath);
  const exact = files?.filter((file) => normalizeReviewPath(file.filePath) === exactPath);
  return exact?.length === 1 ? exact[0] : undefined;
}

export function collectReviewPathAliases(
  files: readonly Pick<FileChangeSummary, 'filePath'>[] | null | undefined,
  requestedPath: string,
  canonicalPath: string,
  records: readonly Readonly<Record<string, unknown>>[]
): Set<string> {
  const aliases = new Set([requestedPath, canonicalPath]);
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (
        normalizeReviewPathForIdentity(key) === normalizeReviewPathForIdentity(requestedPath) ||
        findReviewFileByPath(files, key)?.filePath === canonicalPath
      ) {
        aliases.add(key);
      }
    }
  }
  return aliases;
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
  const exactAliases = new Map<string, string | null>();
  const foldedAliases = new Map<string, string | null>();
  const recordAlias = (
    aliases: Map<string, string | null>,
    alias: string,
    reviewKey: string
  ): void => {
    const existing = aliases.get(alias);
    aliases.set(alias, existing === undefined || existing === reviewKey ? reviewKey : null);
  };
  const addAlias = (alias: string, reviewKey: string, forceCaseInsensitive = false): void => {
    recordAlias(exactAliases, alias, reviewKey);
    recordAlias(exactAliases, normalizeReviewAlias(alias), reviewKey);
    if (forceCaseInsensitive) {
      recordAlias(foldedAliases, normalizeReviewAlias(alias, true), reviewKey);
    }
  };
  const resolveReviewKey = (alias: string): string | undefined => {
    if (exactAliases.has(alias)) return exactAliases.get(alias) ?? undefined;
    const normalized = normalizeReviewAlias(alias);
    if (exactAliases.has(normalized)) return exactAliases.get(normalized) ?? undefined;
    return foldedAliases.get(normalizeReviewAlias(alias, true)) ?? undefined;
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
