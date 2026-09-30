import { api } from '@renderer/api';
import {
  getReviewChangeSetIdentityToken,
  type ReviewChangeSetLike,
} from '@renderer/utils/reviewDecisionScope';
import {
  collectReviewPathAliases,
  findReviewFileByPath,
  getReviewEntryKey,
  normalizeReviewPathForIdentity,
} from '@renderer/utils/reviewKey';
import { createLogger } from '@shared/utils/logger';

import type { FileChangeSummary, FileChangeWithContent, ReviewFileScope } from '@shared/types';

const savedEntriesAwaitingOriginal = new WeakSet<FileChangeWithContent>();
const logger = createLogger('changeReviewSaveCache');

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
      const nextContent: FileChangeWithContent = {
        ...(cached ?? summary),
        filePath: canonicalFilePath,
        originalFullContent: cached?.originalFullContent ?? null,
        modifiedFullContent: savedContent,
        contentSource: 'disk-current',
      };
      nextContents[contentKey] = nextContent;
      if ((!cached && summary) || (cached && savedEntriesAwaitingOriginal.has(cached))) {
        savedEntriesAwaitingOriginal.add(nextContent);
      }
    }
  }
  return nextContents;
}

export function prepareSavedReviewCache(
  state: {
    activeChangeSet: { files: FileChangeSummary[] } | null;
    editedContents: Record<string, string>;
    fileChunkCounts: Record<string, number>;
    hunkContextHashesByFile: Record<string, Record<number, string>>;
    reviewExternalChangesByFile: Readonly<Record<string, unknown>>;
    fileContents: Record<string, FileChangeWithContent>;
  },
  requestedPath: string,
  canonicalFilePath: string,
  savedContent: string
): { aliases: Set<string>; nextContents: Record<string, FileChangeWithContent> } {
  const { aliases, entryKeys } = collectSavedReviewAliases(
    state.activeChangeSet?.files,
    requestedPath,
    canonicalFilePath,
    [
      state.editedContents,
      state.fileChunkCounts,
      state.hunkContextHashesByFile,
      state.reviewExternalChangesByFile,
      state.fileContents,
    ]
  );
  return {
    aliases,
    nextContents: updateSavedReviewFileContents(
      state.activeChangeSet?.files,
      state.fileContents,
      aliases,
      entryKeys,
      canonicalFilePath,
      requestedPath,
      savedContent
    ),
  };
}

interface SavedReviewOriginalRequest {
  changeSetEpoch: number;
  changeSetIdentity: string | null;
  fileEntry: FileChangeSummary | undefined;
  contentKey: string;
}

export function requestSavedReviewOriginalsAfterSave(
  state: {
    activeChangeSet: ReviewChangeSetLike | null;
    changeSetEpoch: number;
    fileContents: Record<string, FileChangeWithContent>;
  },
  scope: ReviewFileScope,
  canonicalFilePath: string,
  changeSetEpoch: number,
  changeSetIdentity: string | null,
  publish: (request: SavedReviewOriginalRequest, resolved: FileChangeWithContent) => void
): void {
  const files = state.activeChangeSet?.files;
  if (
    !files ||
    state.changeSetEpoch !== changeSetEpoch ||
    getReviewChangeSetIdentityToken(state.activeChangeSet) !== changeSetIdentity
  ) {
    return;
  }
  const keys = getReviewEntryKeysForDiskPath(files, canonicalFilePath);
  for (const contentKey of keys) {
    const cached = state.fileContents[contentKey];
    if (
      !cached ||
      !savedEntriesAwaitingOriginal.has(cached) ||
      cached.originalFullContent !== null
    ) {
      continue;
    }
    const fileEntry = findReviewFileByPath(files, contentKey);
    if (!fileEntry) continue;
    const request = { changeSetEpoch, changeSetIdentity, fileEntry, contentKey };
    void (async () => {
      try {
        const resolved = await api.review.getFileContent(
          scope.teamName,
          scope.memberName,
          fileEntry.filePath,
          fileEntry.snippets
        );
        if (resolved) publish(request, resolved);
      } catch {
        logger.debug('Saved review original hydration unavailable');
      }
    })();
  }
}

/** A superseded fetch may supply the historical baseline, never its stale postimage. */
export function hydrateSavedReviewOriginal(
  state: {
    activeChangeSet: ReviewChangeSetLike | null;
    changeSetEpoch: number;
    fileContents: Record<string, FileChangeWithContent>;
  },
  request: SavedReviewOriginalRequest,
  resolved: FileChangeWithContent
): { fileContents: Record<string, FileChangeWithContent> } | null {
  const { fileEntry, contentKey } = request;
  if (!fileEntry || !state.activeChangeSet || state.changeSetEpoch !== request.changeSetEpoch) {
    return null;
  }
  if (getReviewChangeSetIdentityToken(state.activeChangeSet) !== request.changeSetIdentity) {
    return null;
  }
  const currentEntry = findReviewFileByPath(state.activeChangeSet.files, contentKey);
  if (
    !currentEntry ||
    getReviewEntryKey(state.activeChangeSet.files, currentEntry) !== contentKey ||
    currentEntry.snippets !== fileEntry.snippets ||
    currentEntry.filePath !== resolved.filePath ||
    JSON.stringify(resolved.snippets) !== JSON.stringify(fileEntry.snippets)
  ) {
    return null;
  }
  const current = state.fileContents[contentKey];
  if (
    !current ||
    !savedEntriesAwaitingOriginal.has(current) ||
    current.originalFullContent !== null ||
    resolved.originalFullContent === null ||
    (resolved.contentSource !== 'ledger-exact' && resolved.contentSource !== 'ledger-snapshot')
  ) {
    return null;
  }
  return {
    fileContents: {
      ...state.fileContents,
      [contentKey]: { ...current, originalFullContent: resolved.originalFullContent },
    },
  };
}
