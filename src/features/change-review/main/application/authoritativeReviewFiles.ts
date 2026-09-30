import type {
  FileChangeSummary,
  ReviewDirectDiskMutationStep,
  ReviewDiskUndoSnapshot,
  ReviewUndoAction,
  SnippetDiff,
} from '@shared/types/review';

export type AuthoritativeReviewFiles = Map<string, FileChangeSummary[]>;

export interface AuthoritativeReviewFileHost {
  normalize(filePath: string): string;
  isAbsolute(filePath: string): boolean;
  deepEqual(left: unknown, right: unknown): boolean;
}

export function collectAuthoritativeReviewedFiles(
  files: FileChangeSummary[],
  host: AuthoritativeReviewFileHost
): AuthoritativeReviewFiles {
  const reviewedFiles: AuthoritativeReviewFiles = new Map();
  for (const file of files) {
    for (const filePath of [file.filePath, ...file.snippets.map((snippet) => snippet.filePath)]) {
      if (!filePath || !host.isAbsolute(filePath)) continue;
      const key = host.normalize(filePath);
      const owners = reviewedFiles.get(key) ?? [];
      if (!owners.includes(file)) owners.push(file);
      reviewedFiles.set(key, owners);
    }
  }
  return reviewedFiles;
}

export function getAuthoritativeReviewedFile(
  authorization: {
    reviewedFiles: AuthoritativeReviewFiles | null;
    identity: AuthoritativeReviewFileHost;
    selectedReviewKeys?: ReadonlyMap<string, string>;
  },
  filePath: string,
  reviewKey?: string
): FileChangeSummary {
  const { identity } = authorization;
  const normalizedPath = identity.normalize(filePath);
  const files = authorization.reviewedFiles?.get(normalizedPath) ?? [];
  const selectedKey = reviewKey ?? authorization.selectedReviewKeys?.get(normalizedPath);
  if (files.length === 0) throw new Error('File is not part of the reviewed scope');
  if (selectedKey !== undefined) {
    const matches = files.filter(
      (file) =>
        identity.normalize(file.filePath) === normalizedPath &&
        (file.changeKey ?? file.filePath) === selectedKey
    );
    if (matches.length !== 1) {
      throw new Error('Durable reviewKey does not match the authoritative review identity');
    }
    return matches[0];
  }
  if (files.length !== 1) throw new Error('Ambiguous reviewed file; reviewKey is required');
  return files[0];
}

export function getAuthoritativeReviewedPhysicalFiles(
  authorization: Parameters<typeof getAuthoritativeReviewedFile>[0],
  filePath: string
): FileChangeSummary[] {
  if (!authorization.identity.isAbsolute(filePath)) {
    throw new Error('Review file path must be absolute');
  }
  const normalized = authorization.identity.normalize(filePath);
  const files = (authorization.reviewedFiles?.get(normalized) ?? []).filter(
    (file) => authorization.identity.normalize(file.filePath) === normalized
  );
  if (files.length === 0) throw new Error('File is not part of the reviewed scope');
  return files;
}

export function getAuthoritativePersistedReviewFile(
  authorization: Parameters<typeof getAuthoritativeReviewedFile>[0],
  filePath: string,
  persistedFiles: readonly (Pick<FileChangeSummary, 'filePath' | 'changeKey'> | undefined)[]
): FileChangeSummary {
  const keys = new Set(persistedFiles.flatMap((file) => (file?.changeKey ? [file.changeKey] : [])));
  if (keys.size > 1) throw new Error('Review history contains conflicting review identities');
  const selectedKey = authorization.selectedReviewKeys?.get(
    authorization.identity.normalize(filePath)
  );
  if (selectedKey && keys.size > 0 && !keys.has(selectedKey)) {
    throw new Error('Review history file identity does not match the selected reviewKey');
  }
  const file = getAuthoritativeReviewedFile(authorization, filePath, [...keys][0]);
  if (
    persistedFiles.some(
      (persisted) =>
        persisted &&
        (authorization.identity.normalize(persisted.filePath) !==
          authorization.identity.normalize(file.filePath) ||
          (persisted.changeKey !== undefined && persisted.changeKey !== file.changeKey))
    )
  ) {
    throw new Error('Review history file identity does not match the authoritative review');
  }
  return file;
}

export function getAuthoritativeReviewedActionFile(
  authorization: Parameters<typeof getAuthoritativeReviewedFile>[0],
  filePath: string,
  action: ReviewUndoAction
): FileChangeSummary {
  return getAuthoritativePersistedReviewFile(
    authorization,
    filePath,
    action.kind === 'disk' ? [action.action.file, action.action.snapshot.file] : []
  );
}

export function getAuthoritativeRenameStepFile(
  authorization: Parameters<typeof getAuthoritativeReviewedFile>[0],
  step: Extract<
    ReviewDirectDiskMutationStep,
    { type: 'restore-rejected-rename' | 'reapply-rejected-rename' }
  >,
  actions: readonly ReviewUndoAction[]
): FileChangeSummary {
  let owner: FileChangeSummary | null = null;
  for (const action of actions) {
    const snapshots =
      action.kind === 'bulk'
        ? action.diskSnapshots
        : action.kind === 'disk'
          ? [action.action.snapshot]
          : [];
    for (const [index, snapshot] of snapshots.entries()) {
      if (step.id !== `${action.id}:${index}` && step.id !== `${action.id}:redo:${index}`) continue;
      if (
        owner ||
        authorization.identity.normalize(snapshot.filePath) !==
          authorization.identity.normalize(step.filePath) ||
        !snapshot.renameExpectation ||
        !authorization.identity.deepEqual(snapshot.renameExpectation, step.expectation) ||
        !['restore-rejected-rename', 'reapply-rejected-rename'].includes(
          snapshot.restoreMode ?? 'restore-rejected-rename'
        )
      ) {
        throw new Error('Review rename step does not match its durable history snapshot');
      }
      owner = getAuthoritativePersistedReviewFile(authorization, step.filePath, [
        snapshot.file,
        action.kind === 'disk' ? action.action.file : undefined,
      ]);
    }
  }
  if (!owner) throw new Error('Review rename step has no bound history snapshot');
  return owner;
}

export function findLatestRestorableReviewSnapshot(
  actions: readonly ReviewUndoAction[],
  filePath: string,
  file: FileChangeSummary,
  authorization: Parameters<typeof getAuthoritativeReviewedFile>[0],
  isBound: (snapshot: ReviewDiskUndoSnapshot) => boolean
): ReviewDiskUndoSnapshot | null {
  const normalizedPath = authorization.identity.normalize(filePath);
  for (let index = actions.length - 1; index >= 0; index--) {
    const action = actions[index];
    if (!action) continue;
    const snapshots =
      action.kind === 'bulk'
        ? action.diskSnapshots
        : action.kind === 'disk'
          ? [action.action.snapshot]
          : [];
    const matchingSnapshot = [...snapshots].reverse().find((candidate) => {
      if (authorization.identity.normalize(candidate.filePath) !== normalizedPath) return false;
      const owner = getAuthoritativePersistedReviewFile(authorization, candidate.filePath, [
        candidate.file,
        action.kind === 'disk' ? action.action.file : undefined,
      ]);
      return owner.changeKey === file.changeKey;
    });
    if (!matchingSnapshot) continue;
    if (matchingSnapshot.restoreConflict) throw new Error(matchingSnapshot.restoreConflict);
    if (!isBound(matchingSnapshot)) {
      throw new Error('Review history predates authoritative disk snapshots; reload Changes');
    }
    if (matchingSnapshot.renameExpectation) return null;
    if (action.kind === 'disk' && action.action.originalIndex !== undefined) continue;
    return matchingSnapshot;
  }
  return null;
}

export function isAuthoritativeReviewDeletion(file: FileChangeSummary): boolean {
  if (file.ledgerSummary?.latestOperation) {
    return file.ledgerSummary.latestOperation === 'delete';
  }
  if (file.ledgerSummary?.afterState?.exists !== undefined) {
    return !file.ledgerSummary.afterState.exists;
  }
  const latestLedger = file.snippets
    .filter((snippet) => snippet.ledger && !snippet.isError)
    .at(-1)?.ledger;
  return (
    latestLedger?.operation === 'delete' ||
    latestLedger?.afterState?.exists === false ||
    file.ledgerSummary?.deletedInTask === true
  );
}

export function getDisplayedReviewedFile(
  authorization: Parameters<typeof getAuthoritativeReviewedFile>[0],
  filePath: string,
  snippets: SnippetDiff[]
): FileChangeSummary | null {
  const normalizedPath = authorization.identity.normalize(filePath);
  const files = authorization.reviewedFiles?.get(normalizedPath) ?? [];
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];
  const matches = files.filter(
    (file) =>
      authorization.identity.normalize(file.filePath) === normalizedPath &&
      JSON.stringify(file.snippets) === JSON.stringify(snippets)
  );
  if (matches.length !== 1) throw new Error('Ambiguous displayed review identity');
  return matches[0];
}
