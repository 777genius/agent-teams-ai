import {
  collectReviewPathAliases,
  getReviewEntryKey,
  normalizeReviewPathForIdentity,
} from '@renderer/utils/reviewKey';

import type { FileChangeSummary, FileChangeWithContent } from '@shared/types';

/** Every ledger entry for one disk path needs its own cache slot and request version. */
export function getReviewEntryKeysForDiskPath(
  files: readonly FileChangeSummary[] | null | undefined,
  filePath: string
): string[] {
  if (!files) return [];
  const path = normalizeReviewPathForIdentity(filePath);
  return files
    .filter((entry) => normalizeReviewPathForIdentity(entry.filePath) === path)
    .map((entry) => getReviewEntryKey(files, entry));
}

export function invalidateSavedReviewFileRequests(
  state: {
    activeChangeSet: { files: FileChangeSummary[] } | null;
    fileContentsLoading: Record<string, boolean>;
    fileContentVersionByPath: Record<string, number>;
  },
  requestedPath: string,
  canonicalFilePath: string
): Pick<typeof state, 'fileContentsLoading' | 'fileContentVersionByPath'> {
  const aliases = collectReviewPathAliases(
    state.activeChangeSet?.files,
    requestedPath,
    canonicalFilePath,
    [state.fileContentsLoading, state.fileContentVersionByPath]
  );
  for (const key of getReviewEntryKeysForDiskPath(
    state.activeChangeSet?.files,
    canonicalFilePath
  )) {
    aliases.add(key);
  }
  const nextLoading = { ...state.fileContentsLoading };
  const nextVersions = { ...state.fileContentVersionByPath };
  for (const alias of aliases) {
    nextLoading[alias] = false;
    nextVersions[alias] = (state.fileContentVersionByPath[alias] ?? 0) + 1;
  }
  return { fileContentsLoading: nextLoading, fileContentVersionByPath: nextVersions };
}

export function collectSavedReviewAliases(
  files: readonly FileChangeSummary[] | null | undefined,
  requestedPath: string,
  canonicalFilePath: string,
  records: readonly Readonly<Record<string, unknown>>[]
): { aliases: Set<string>; entryKeys: string[] } {
  const aliases = collectReviewPathAliases(files, requestedPath, canonicalFilePath, records);
  const entryKeys = getReviewEntryKeysForDiskPath(files, canonicalFilePath);
  for (const key of entryKeys) aliases.add(key);
  return { aliases, entryKeys };
}

export function updateSavedReviewFileContents(
  files: readonly FileChangeSummary[] | null | undefined,
  fileContents: Record<string, FileChangeWithContent>,
  aliases: ReadonlySet<string>,
  entryKeys: readonly string[],
  canonicalFilePath: string,
  requestedPath: string,
  savedContent: string
): Record<string, FileChangeWithContent> {
  const nextContents = { ...fileContents };
  const contentKeys = entryKeys.length > 0 ? entryKeys : [canonicalFilePath];
  const existing = nextContents[canonicalFilePath] ?? nextContents[requestedPath];
  for (const alias of aliases) {
    if (!contentKeys.includes(alias)) delete nextContents[alias];
  }
  for (const contentKey of contentKeys) {
    const cached = nextContents[contentKey] ?? (contentKeys.length === 1 ? existing : undefined);
    const summary =
      contentKeys.length > 1 ? files?.find((entry) => entry.changeKey === contentKey) : undefined;
    if (cached || summary) {
      nextContents[contentKey] = {
        ...(cached ?? summary),
        filePath: canonicalFilePath,
        originalFullContent: cached?.originalFullContent ?? null,
        modifiedFullContent: savedContent,
        contentSource: 'disk-current',
      };
    }
  }
  return nextContents;
}
