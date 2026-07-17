/**
 * IPC handlers for code review / diff view feature.
 *
 * Паттерн: module-level state + guard + wrapReviewHandler (как teams.ts)
 */

import { ReviewDraftHistoryStore } from '@features/change-review-history/main';
import { ReviewMutationCoordinator } from '@features/review-mutations/main';
import { validateTaskId, validateTeamName } from '@main/ipc/guards';
import { createIpcWrapper } from '@main/ipc/ipcWrapper';
import { EditorFileWatcher } from '@main/services/editor';
import { ReviewDecisionStore } from '@main/services/team/ReviewDecisionStore';
import {
  type ReviewMutationJournalDiskStep,
  type ReviewMutationJournalPathPostimage,
  type ReviewMutationJournalRecord,
  ReviewMutationJournalStore,
} from '@main/services/team/ReviewMutationJournalStore';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { cleanupAtomicCreateTempLinks } from '@main/utils/atomicWrite';
import { isPathWithinRoot, matchesSensitivePattern } from '@main/utils/pathValidation';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import {
  REVIEW_APPLY_DECISIONS,
  REVIEW_CHECK_CONFLICT,
  REVIEW_CLEAR_DECISIONS,
  REVIEW_CLEAR_DRAFT_HISTORY,
  REVIEW_DELETE_EDITED_FILE,
  REVIEW_EXECUTE_MUTATION,
  REVIEW_FILE_CHANGE,
  REVIEW_GET_AGENT_CHANGES,
  REVIEW_GET_CHANGE_STATS,
  REVIEW_GET_FILE_CONTENT,
  REVIEW_GET_GIT_FILE_LOG,
  REVIEW_GET_TASK_CHANGES,
  REVIEW_GET_TEAM_TASK_CHANGE_SUMMARIES,
  REVIEW_INVALIDATE_TASK_CHANGE_SUMMARIES,
  REVIEW_LOAD_DECISIONS,
  REVIEW_LOAD_DRAFT_HISTORY,
  REVIEW_PREVIEW_REJECT,
  REVIEW_REAPPLY_REJECTED_RENAME,
  REVIEW_REJECT_FILE,
  REVIEW_REJECT_HUNKS,
  REVIEW_RESTORE_REJECTED_RENAME,
  REVIEW_SAVE_DECISIONS,
  REVIEW_SAVE_DRAFT_HISTORY_ENTRY,
  REVIEW_SAVE_EDITED_FILE,
  REVIEW_UNWATCH_FILES,
  REVIEW_WATCH_FILES,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import type {
  ReviewDraftHistoryEntry,
  ReviewDraftHistorySnapshot,
} from '@features/change-review-history/contracts';
import type { ChangeExtractorService } from '@main/services/team/ChangeExtractorService';
import type { FileContentResolver } from '@main/services/team/FileContentResolver';
import type { GitDiffFallback } from '@main/services/team/GitDiffFallback';
import type { ReviewApplierService } from '@main/services/team/ReviewApplierService';
import type { IpcResult } from '@shared/types/ipc';
import type {
  AgentChangeSet,
  ApplyReviewRequest,
  ApplyReviewResult,
  ChangeStats,
  ConflictCheckResult,
  ExecuteReviewMutationRequest,
  FileChangeSummary,
  FileChangeWithContent,
  FileReviewDecision,
  HunkDecision,
  RejectResult,
  ReviewDecisionPersistenceScope,
  ReviewFileScope,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewRenameRecoveryExpectation,
  ReviewUndoAction,
  SnippetDiff,
  TaskChangeRequestOptions,
  TaskChangeSetV2,
  TeamTaskChangeSummariesResponse,
  TeamTaskChangeSummaryRequest,
} from '@shared/types/review';
import type { TeamConfig } from '@shared/types/team';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

const wrapReviewHandler = createIpcWrapper('IPC:review');
const logger = createLogger('IPC:review');
const TEAM_TASK_CHANGE_SUMMARY_IPC_RAW_REQUEST_LIMIT = 1_000;
const TEAM_TASK_CHANGE_SUMMARY_IPC_UNIQUE_REQUEST_LIMIT = 201;
const MAX_REVIEW_DECISIONS = 2_000;
const MAX_REVIEW_SNIPPETS_PER_FILE = 10_000;
const MAX_REVIEW_HUNK_DECISIONS_PER_FILE = 100_000;
const MAX_REVIEW_MUTATION_STEPS = 2_000;

// --- Module-level state ---

let changeExtractor: ChangeExtractorService | null = null;
let reviewApplier: ReviewApplierService | null = null;
let fileContentResolver: FileContentResolver | null = null;
let gitDiffFallback: GitDiffFallback | null = null;
let reviewConfigReader: Pick<TeamConfigReader, 'getConfig'> = new TeamConfigReader();
const reviewDecisionStore = new ReviewDecisionStore();
const reviewDraftHistoryStore = new ReviewDraftHistoryStore();
const reviewMutationJournal = new ReviewMutationJournalStore();
const reviewMutationCoordinator = new ReviewMutationCoordinator(reviewMutationJournal);
const reviewDecisionPersistenceQueues = new Map<string, Promise<void>>();
// Review is backed by a point-in-time diff. Unlike the editor watcher, ignoring
// the first few seconds can silently miss an external write and make Undo unsafe.
const reviewFileWatcher = new EditorFileWatcher({ ignoreStartupChanges: false });
let reviewWatcherProjectRoot: string | null = null;
let reviewMainWindowRef: BrowserWindow | null = null;

async function withReviewDecisionPersistenceLock<T>(
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope,
  operation: () => Promise<T>
): Promise<T> {
  const scopeHash = createHash('sha256').update(persistenceScope.scopeToken).digest('hex');
  const key = `${teamName}:${persistenceScope.scopeKey}:${scopeHash}`;
  const previous = reviewDecisionPersistenceQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueTail = previous.then(
    () => current,
    () => current
  );
  reviewDecisionPersistenceQueues.set(key, queueTail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (reviewDecisionPersistenceQueues.get(key) === queueTail) {
      reviewDecisionPersistenceQueues.delete(key);
    }
  }
}

interface DisplayedReviewSnapshot {
  teamName: string;
  filePath: string;
  snippetFingerprint: string;
  content: FileChangeWithContent;
  expiresAt: number;
}

const displayedReviewSnapshots = new Map<string, DisplayedReviewSnapshot>();
const REVIEW_SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const MAX_DISPLAYED_REVIEW_SNAPSHOTS = 2_000;

function fingerprintReviewSnippets(snippets: SnippetDiff[]): string {
  return createHash('sha256').update(JSON.stringify(snippets)).digest('hex');
}

function registerDisplayedReviewSnapshot(
  teamName: string,
  filePath: string,
  snippets: SnippetDiff[],
  content: FileChangeWithContent
): FileChangeWithContent {
  const now = Date.now();
  for (const [token, snapshot] of displayedReviewSnapshots) {
    if (snapshot.expiresAt <= now) displayedReviewSnapshots.delete(token);
  }
  while (displayedReviewSnapshots.size >= MAX_DISPLAYED_REVIEW_SNAPSHOTS) {
    const oldestToken = displayedReviewSnapshots.keys().next().value;
    if (!oldestToken) break;
    displayedReviewSnapshots.delete(oldestToken);
  }

  const token = randomUUID();
  const snapshotContent = { ...content, reviewSnapshotToken: token };
  displayedReviewSnapshots.set(token, {
    teamName,
    filePath: normalizeReviewPathForIdentity(filePath),
    snippetFingerprint: fingerprintReviewSnippets(snippets),
    content: snapshotContent,
    expiresAt: now + REVIEW_SNAPSHOT_TTL_MS,
  });
  return snapshotContent;
}

function resolveDisplayedReviewSnapshot(
  token: string | undefined,
  teamName: string,
  filePath: string,
  authoritativeSnippets: SnippetDiff[]
): FileChangeWithContent {
  if (!token) {
    throw new Error('Displayed review snapshot is unavailable; reload Changes before rejecting.');
  }
  const snapshot = displayedReviewSnapshots.get(token);
  if (
    !snapshot ||
    snapshot.expiresAt <= Date.now() ||
    snapshot.teamName !== teamName ||
    snapshot.filePath !== normalizeReviewPathForIdentity(filePath) ||
    snapshot.snippetFingerprint !== fingerprintReviewSnippets(authoritativeSnippets)
  ) {
    displayedReviewSnapshots.delete(token);
    throw new Error('Displayed review snapshot is stale; reload Changes before rejecting.');
  }
  snapshot.expiresAt = Date.now() + REVIEW_SNAPSHOT_TTL_MS;
  return {
    ...snapshot.content,
    filePath,
    snippets: authoritativeSnippets,
  };
}

function getChangeExtractor(): ChangeExtractorService {
  if (!changeExtractor) throw new Error('Review handlers not initialized');
  return changeExtractor;
}

function getApplier(): ReviewApplierService {
  if (!reviewApplier) throw new Error('ReviewApplierService not initialized');
  return reviewApplier;
}

function getContentResolver(): FileContentResolver {
  if (!fileContentResolver) throw new Error('FileContentResolver not initialized');
  return fileContentResolver;
}

interface AuthorizedReviewRoot {
  lexicalPath: string;
  realPath: string;
}

interface ReviewPathAuthorization {
  roots: AuthorizedReviewRoot[];
  reviewedFiles: Map<string, FileChangeSummary> | null;
  resolutionMemberName: string;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${field}: non-empty string required`);
  }
}

function assertOptionalString(value: unknown, field: string): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`Invalid ${field}: string required`);
  }
}

function normalizeReviewIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseReviewFileScope(value: unknown): ReviewFileScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid review scope');
  }
  const raw = value as Record<string, unknown>;
  const team = validateTeamName(raw.teamName);
  if (!team.valid || !team.value) {
    throw new Error(team.error ?? 'Invalid teamName');
  }
  assertOptionalString(raw.memberName, 'memberName');
  assertOptionalString(raw.taskId, 'taskId');
  const memberName = normalizeReviewIdentity(raw.memberName);
  const taskId = normalizeReviewIdentity(raw.taskId);
  if (taskId) {
    const task = validateTaskId(taskId);
    if (!task.valid || !task.value) {
      throw new Error(task.error ?? 'Invalid taskId');
    }
  }
  if (memberName && (memberName.length > 256 || memberName.includes('\0'))) {
    throw new Error('Invalid memberName');
  }
  return {
    teamName: team.value,
    ...(memberName ? { memberName } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

function parseReviewRenameRecoveryExpectation(value: unknown): ReviewRenameRecoveryExpectation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid rename recovery expectation');
  }
  const raw = value as Record<string, unknown>;
  const relation = raw.relation;
  if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
    throw new Error('Invalid rename recovery relation');
  }
  const relationRaw = relation as Record<string, unknown>;
  if (
    typeof raw.eventId !== 'string' ||
    !raw.eventId ||
    raw.eventId.length > 512 ||
    (raw.beforeHash !== null && typeof raw.beforeHash !== 'string') ||
    (raw.afterHash !== null && typeof raw.afterHash !== 'string') ||
    relationRaw.kind !== 'rename' ||
    typeof relationRaw.oldPath !== 'string' ||
    !relationRaw.oldPath ||
    relationRaw.oldPath.length > 4096 ||
    relationRaw.oldPath.includes('\0') ||
    typeof relationRaw.newPath !== 'string' ||
    !relationRaw.newPath ||
    relationRaw.newPath.length > 4096 ||
    relationRaw.newPath.includes('\0')
  ) {
    throw new Error('Invalid rename recovery expectation');
  }
  if (
    (typeof raw.beforeHash === 'string' && raw.beforeHash.length > 512) ||
    (typeof raw.afterHash === 'string' && raw.afterHash.length > 512)
  ) {
    throw new Error('Invalid rename recovery expectation');
  }
  return {
    eventId: raw.eventId,
    beforeHash: raw.beforeHash,
    afterHash: raw.afterHash,
    relation: {
      kind: 'rename',
      oldPath: relationRaw.oldPath,
      newPath: relationRaw.newPath,
    },
  };
}

function collectConfiguredReviewRoots(config: TeamConfig): string[] {
  const roots: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      roots.push(value.trim());
    }
  };
  add(config.projectPath);

  const members = Array.isArray(config.members) ? config.members : [];
  for (const member of members) {
    add(member.cwd);
  }
  return [...new Set(roots.map((root) => path.resolve(path.normalize(root))))];
}

async function resolveAuthorizedReviewRoot(rootPath: string): Promise<AuthorizedReviewRoot | null> {
  if (!path.isAbsolute(rootPath)) {
    return null;
  }
  try {
    const [rootStat, realPath] = await Promise.all([fs.stat(rootPath), fs.realpath(rootPath)]);
    if (!rootStat.isDirectory()) {
      return null;
    }
    return {
      lexicalPath: path.resolve(path.normalize(rootPath)),
      realPath: path.resolve(path.normalize(realPath)),
    };
  } catch {
    return null;
  }
}

function normalizeReviewPathForIdentity(filePath: string): string {
  const normalized = path.resolve(path.normalize(filePath));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function collectAuthoritativeReviewedFiles(
  files: FileChangeSummary[]
): Map<string, FileChangeSummary> {
  const reviewedFiles = new Map<string, FileChangeSummary>();
  const add = (filePath: string | null, owner: FileChangeSummary): void => {
    if (filePath && path.isAbsolute(path.normalize(filePath))) {
      reviewedFiles.set(normalizeReviewPathForIdentity(filePath), owner);
    }
  };

  for (const file of files) {
    add(file.filePath, file);
    for (const snippet of file.snippets) {
      add(snippet.filePath, file);
    }
  }
  return reviewedFiles;
}

async function resolveReviewPathAuthorization(
  scopeValue: unknown,
  options: { requireIdentity?: boolean } = {}
): Promise<{ scope: ReviewFileScope; authorization: ReviewPathAuthorization }> {
  const scope = parseReviewFileScope(scopeValue);
  if (options.requireIdentity && !scope.taskId && !scope.memberName) {
    throw new Error('Review mutation requires taskId or memberName');
  }
  const config = await reviewConfigReader.getConfig(scope.teamName);
  if (!config) {
    throw new Error(`Review team config is unavailable: ${scope.teamName}`);
  }

  const roots = (
    await Promise.all(collectConfiguredReviewRoots(config).map(resolveAuthorizedReviewRoot))
  ).filter((root): root is AuthorizedReviewRoot => Boolean(root));
  if (roots.length === 0) {
    throw new Error('Review project/worktree root is unavailable');
  }

  let reviewedFiles: Map<string, FileChangeSummary> | null = null;
  let resolutionMemberName = scope.memberName ?? '';
  if (scope.taskId) {
    const changeSet = await getChangeExtractor().getTaskChanges(scope.teamName, scope.taskId);
    reviewedFiles = collectAuthoritativeReviewedFiles(changeSet.files);
    const authoritativeMemberName = normalizeReviewIdentity(changeSet.scope?.memberName);
    if (
      scope.memberName &&
      authoritativeMemberName &&
      scope.memberName !== authoritativeMemberName
    ) {
      throw new Error('Review memberName does not match the authoritative task scope');
    }
    resolutionMemberName = authoritativeMemberName ?? '';
  } else if (scope.memberName) {
    const changeSet = await getChangeExtractor().getAgentChanges(scope.teamName, scope.memberName);
    reviewedFiles = collectAuthoritativeReviewedFiles(changeSet.files);
  }

  return { scope, authorization: { roots, reviewedFiles, resolutionMemberName } };
}

async function resolveNearestExistingRealPath(filePath: string): Promise<string> {
  let current = filePath;
  for (;;) {
    try {
      return path.resolve(path.normalize(await fs.realpath(current)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error('No existing ancestor for review file path');
      }
      current = parent;
    }
  }
}

async function validateAuthorizedReviewFilePath(
  authorization: ReviewPathAuthorization,
  filePathValue: unknown,
  options: { requireReviewedFile: boolean; rejectHardlinks?: boolean }
): Promise<string> {
  assertNonEmptyString(filePathValue, 'filePath');
  if (!path.isAbsolute(path.normalize(filePathValue))) {
    throw new Error('Review file path must be absolute');
  }
  const normalizedPath = path.resolve(path.normalize(filePathValue));
  if (matchesSensitivePattern(normalizedPath)) {
    throw new Error('Access to sensitive files is not allowed');
  }
  if (
    options.requireReviewedFile &&
    !authorization.reviewedFiles?.has(normalizeReviewPathForIdentity(normalizedPath))
  ) {
    throw new Error('File is not part of the reviewed scope');
  }

  let targetRealPath: string;
  let targetStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  let resolvedStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    targetStat = await fs.lstat(normalizedPath);
    targetRealPath = path.resolve(path.normalize(await fs.realpath(normalizedPath)));
    resolvedStat = targetStat.isSymbolicLink() ? await fs.stat(targetRealPath) : targetStat;
    if (!resolvedStat.isFile()) {
      throw new Error('Review target must be a regular file');
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw error;
    }
    targetRealPath = await resolveNearestExistingRealPath(path.dirname(normalizedPath));
  }
  if (matchesSensitivePattern(targetRealPath)) {
    throw new Error('Access to sensitive files is not allowed');
  }

  const allowed = authorization.roots.some(
    (root) =>
      (isPathWithinRoot(normalizedPath, root.lexicalPath) ||
        isPathWithinRoot(normalizedPath, root.realPath)) &&
      isPathWithinRoot(targetRealPath, root.realPath)
  );
  if (!allowed) {
    throw new Error('Review file path is outside the authoritative project/worktree');
  }
  if (options.rejectHardlinks && targetStat && resolvedStat) {
    if (!targetStat.isSymbolicLink() && resolvedStat.nlink > 1) {
      await cleanupAtomicCreateTempLinks(normalizedPath);
      targetStat = await fs.lstat(normalizedPath);
      targetRealPath = path.resolve(path.normalize(await fs.realpath(normalizedPath)));
      resolvedStat = targetStat.isSymbolicLink() ? await fs.stat(targetRealPath) : targetStat;
      const stillAllowed =
        !matchesSensitivePattern(targetRealPath) &&
        authorization.roots.some(
          (root) =>
            (isPathWithinRoot(normalizedPath, root.lexicalPath) ||
              isPathWithinRoot(normalizedPath, root.realPath)) &&
            isPathWithinRoot(targetRealPath, root.realPath)
        );
      if (!stillAllowed || !resolvedStat.isFile()) {
        throw new Error('Review file path changed during authorization');
      }
    }
    if (targetStat.isSymbolicLink() || resolvedStat.nlink > 1) {
      throw new Error('Review mutation refuses symbolic or multiply-linked files');
    }
  }
  return normalizedPath;
}

function getAuthoritativeReviewedFile(
  authorization: ReviewPathAuthorization,
  filePath: string
): FileChangeSummary {
  const file = authorization.reviewedFiles?.get(normalizeReviewPathForIdentity(filePath));
  if (!file) {
    throw new Error('File is not part of the reviewed scope');
  }
  return file;
}

async function resolveAuthoritativeFileContent(
  scope: ReviewFileScope,
  authorization: ReviewPathAuthorization,
  filePath: string
): Promise<FileChangeWithContent> {
  const authoritativeFile = getAuthoritativeReviewedFile(authorization, filePath);
  assertSnippetShapes(authoritativeFile.snippets);
  await validateSnippetPaths(authorization, authoritativeFile.snippets, {
    requireReviewedFile: true,
  });
  const resolved = await getContentResolver().getFileContent(
    scope.teamName,
    authorization.resolutionMemberName,
    filePath,
    authoritativeFile.snippets
  );
  return {
    ...resolved,
    filePath,
    snippets: authoritativeFile.snippets,
  };
}

function assertExpectedAuthoritativeRename(
  content: FileChangeWithContent,
  expectation: ReviewRenameRecoveryExpectation
): void {
  const renameLedger = content.snippets.find(
    (snippet) => snippet.ledger?.relation?.kind === 'rename'
  )?.ledger;
  const relation = renameLedger?.relation;
  if (!renameLedger || relation?.kind !== 'rename') {
    throw new Error('Review file is not an authoritative ledger rename');
  }
  if (
    renameLedger.eventId !== expectation.eventId ||
    (renameLedger.beforeHash ?? null) !== expectation.beforeHash ||
    (renameLedger.afterHash ?? null) !== expectation.afterHash ||
    relation.oldPath !== expectation.relation.oldPath ||
    relation.newPath !== expectation.relation.newPath
  ) {
    throw new Error('Review changes were updated; refusing stale rename recovery');
  }
}

function invalidateAuthoritativeReviewContent(content: FileChangeWithContent): void {
  const paths = new Set([content.filePath]);
  for (const snippet of content.snippets) {
    paths.add(snippet.filePath);
    const relation = snippet.ledger?.relation;
    if (relation) {
      paths.add(relation.oldPath);
      paths.add(relation.newPath);
    }
  }
  for (const filePath of paths) {
    getContentResolver().invalidateFile(filePath);
  }
}

function assertHunkIndices(value: unknown): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_REVIEW_HUNK_DECISIONS_PER_FILE ||
    value.some((index) => !Number.isSafeInteger(index) || index < 0)
  ) {
    throw new Error('Invalid hunkIndices');
  }
}

function assertSnippetShapes(value: unknown): asserts value is SnippetDiff[] {
  if (!Array.isArray(value) || value.length > MAX_REVIEW_SNIPPETS_PER_FILE) {
    throw new Error('Invalid snippets array');
  }
  for (const snippet of value) {
    if (!snippet || typeof snippet !== 'object' || Array.isArray(snippet)) {
      throw new Error('Invalid review snippet');
    }
    const raw = snippet as Record<string, unknown>;
    for (const field of [
      'toolUseId',
      'filePath',
      'toolName',
      'type',
      'oldString',
      'newString',
      'timestamp',
    ]) {
      if (typeof raw[field] !== 'string') {
        throw new Error(`Invalid review snippet ${field}`);
      }
    }
    if (typeof raw.replaceAll !== 'boolean' || typeof raw.isError !== 'boolean') {
      throw new Error('Invalid review snippet flags');
    }
    if (raw.ledger !== undefined) {
      if (!raw.ledger || typeof raw.ledger !== 'object' || Array.isArray(raw.ledger)) {
        throw new Error('Invalid review ledger metadata');
      }
      const relation = (raw.ledger as Record<string, unknown>).relation;
      if (relation !== undefined) {
        if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
          throw new Error('Invalid review relation');
        }
        const relationRaw = relation as Record<string, unknown>;
        if (
          (relationRaw.kind !== 'rename' && relationRaw.kind !== 'copy') ||
          typeof relationRaw.oldPath !== 'string' ||
          !relationRaw.oldPath ||
          typeof relationRaw.newPath !== 'string' ||
          !relationRaw.newPath
        ) {
          throw new Error('Invalid review relation');
        }
      }
    }
  }
}

async function validateSnippetPaths(
  authorization: ReviewPathAuthorization,
  snippets: SnippetDiff[],
  options: { requireReviewedFile?: boolean; rejectHardlinks?: boolean } = {}
): Promise<void> {
  const requireReviewedFile = options.requireReviewedFile === true;
  await Promise.all(
    snippets.map((snippet) =>
      validateAuthorizedReviewFilePath(authorization, snippet.filePath, {
        requireReviewedFile,
        rejectHardlinks: options.rejectHardlinks === true,
      })
    )
  );

  for (const snippet of snippets) {
    const relation = snippet.ledger?.relation;
    if (!relation) continue;
    const slashFilePath = snippet.filePath.replace(/\\/g, '/');
    const relationPaths = [relation.oldPath, relation.newPath] as const;
    if (relationPaths.every((relationPath) => path.isAbsolute(path.normalize(relationPath)))) {
      for (const relationPath of relationPaths) {
        await validateAuthorizedReviewFilePath(authorization, relationPath, {
          requireReviewedFile,
          rejectHardlinks: options.rejectHardlinks === true,
        });
      }
      continue;
    }
    if (relationPaths.some((relationPath) => path.isAbsolute(path.normalize(relationPath)))) {
      throw new Error('Review relation paths must both be absolute or both be relative');
    }

    let resolvedRelationPaths: [string, string] | null = null;
    for (const [anchorRelationPath, targetRelationPath] of [
      [relation.oldPath, relation.newPath],
      [relation.newPath, relation.oldPath],
    ] as const) {
      const slashAnchor = anchorRelationPath.replace(/\\/g, '/');
      if (
        slashFilePath === slashAnchor ||
        slashFilePath.toLocaleLowerCase().endsWith(`/${slashAnchor.toLocaleLowerCase()}`)
      ) {
        const prefix = slashFilePath.slice(0, slashFilePath.length - slashAnchor.length);
        const anchorPath = path.resolve(path.normalize(`${prefix}${slashAnchor}`));
        const targetPath = path.resolve(
          path.normalize(`${prefix}${targetRelationPath.replace(/\\/g, '/')}`)
        );
        resolvedRelationPaths =
          anchorRelationPath === relation.oldPath
            ? [anchorPath, targetPath]
            : [targetPath, anchorPath];
        break;
      }
    }
    if (!resolvedRelationPaths) {
      throw new Error('Review relation is not anchored to an authoritative snippet path');
    }
    for (const relationPath of resolvedRelationPaths) {
      await validateAuthorizedReviewFilePath(authorization, relationPath, {
        requireReviewedFile,
        rejectHardlinks: options.rejectHardlinks === true,
      });
    }
  }
}

function assertReviewDecisionShape(value: unknown): asserts value is FileReviewDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid review decision');
  }
  const raw = value as Record<string, unknown>;
  assertNonEmptyString(raw.filePath, 'decision.filePath');
  if (
    raw.reviewKey !== undefined &&
    (typeof raw.reviewKey !== 'string' ||
      raw.reviewKey.length === 0 ||
      raw.reviewKey.length > 32_768 ||
      raw.reviewKey.includes('\0'))
  ) {
    throw new Error('Invalid decision.reviewKey');
  }
  if (!['accepted', 'rejected', 'pending'].includes(String(raw.fileDecision))) {
    throw new Error('Invalid fileDecision');
  }
  if (
    !raw.hunkDecisions ||
    typeof raw.hunkDecisions !== 'object' ||
    Array.isArray(raw.hunkDecisions) ||
    Object.keys(raw.hunkDecisions).length > MAX_REVIEW_HUNK_DECISIONS_PER_FILE
  ) {
    throw new Error('Invalid hunkDecisions');
  }
  for (const [index, decision] of Object.entries(raw.hunkDecisions)) {
    const numericIndex = Number(index);
    if (
      !/^\d+$/.test(index) ||
      !Number.isSafeInteger(numericIndex) ||
      numericIndex >= MAX_REVIEW_HUNK_DECISIONS_PER_FILE ||
      !['accepted', 'rejected', 'pending'].includes(String(decision))
    ) {
      throw new Error('Invalid hunk decision');
    }
  }
  if (raw.hunkContextHashes !== undefined) {
    if (
      !raw.hunkContextHashes ||
      typeof raw.hunkContextHashes !== 'object' ||
      Array.isArray(raw.hunkContextHashes) ||
      Object.keys(raw.hunkContextHashes).length > MAX_REVIEW_HUNK_DECISIONS_PER_FILE
    ) {
      throw new Error('Invalid hunkContextHashes');
    }
    for (const [index, hash] of Object.entries(raw.hunkContextHashes)) {
      const numericIndex = Number(index);
      if (
        !/^\d+$/.test(index) ||
        !Number.isSafeInteger(numericIndex) ||
        numericIndex >= MAX_REVIEW_HUNK_DECISIONS_PER_FILE ||
        typeof hash !== 'string' ||
        hash.length === 0 ||
        hash.length > 256
      ) {
        throw new Error('Invalid hunk context hash');
      }
    }
  }
  if (
    raw.contentSnapshotToken !== undefined &&
    (typeof raw.contentSnapshotToken !== 'string' || raw.contentSnapshotToken.length > 200)
  ) {
    throw new Error('Invalid contentSnapshotToken');
  }
  if (raw.snippets !== undefined) assertSnippetShapes(raw.snippets);
  for (const field of ['originalFullContent', 'modifiedFullContent']) {
    if (raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== 'string') {
      throw new Error(`Invalid ${field}`);
    }
  }
  if (raw.isNewFile !== undefined && typeof raw.isNewFile !== 'boolean') {
    throw new Error('Invalid isNewFile');
  }
}

function parseDecisionPersistenceScope(
  value: unknown,
  scope: ReviewFileScope
): ReviewDecisionPersistenceScope | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid decision persistence scope');
  }
  const raw = value as Record<string, unknown>;
  assertNonEmptyString(raw.scopeKey, 'decisionPersistenceScope.scopeKey');
  assertNonEmptyString(raw.scopeToken, 'decisionPersistenceScope.scopeToken');
  if (raw.scopeToken.length > 32 * 1024 * 1024 || raw.scopeToken.includes('\0')) {
    throw new Error('Invalid decision persistence scope token');
  }
  const expectedScopeKey = scope.taskId
    ? `task-${scope.taskId}`
    : scope.memberName
      ? `agent-${scope.memberName}`
      : null;
  if (!expectedScopeKey || raw.scopeKey !== expectedScopeKey) {
    throw new Error('Decision persistence scope does not match the authoritative review');
  }
  return { scopeKey: raw.scopeKey, scopeToken: raw.scopeToken };
}

// --- Forward-compatible config object ---

export interface ReviewHandlerDeps {
  extractor: ChangeExtractorService;
  applier?: ReviewApplierService;
  contentResolver?: FileContentResolver;
  gitFallback?: GitDiffFallback;
  configReader?: Pick<TeamConfigReader, 'getConfig'>;
}

export function initializeReviewHandlers(deps: ReviewHandlerDeps): void {
  changeExtractor = deps.extractor;
  if (deps.applier) reviewApplier = deps.applier;
  if (deps.contentResolver) fileContentResolver = deps.contentResolver;
  if (deps.gitFallback) gitDiffFallback = deps.gitFallback;
  reviewConfigReader = deps.configReader ?? new TeamConfigReader();
}

export function registerReviewHandlers(ipcMain: IpcMain): void {
  // Phase 1
  ipcMain.handle(REVIEW_GET_AGENT_CHANGES, handleGetAgentChanges);
  ipcMain.handle(REVIEW_GET_TASK_CHANGES, handleGetTaskChanges);
  ipcMain.handle(REVIEW_GET_TEAM_TASK_CHANGE_SUMMARIES, handleGetTeamTaskChangeSummaries);
  ipcMain.handle(REVIEW_INVALIDATE_TASK_CHANGE_SUMMARIES, handleInvalidateTaskChangeSummaries);
  ipcMain.handle(REVIEW_GET_CHANGE_STATS, handleGetChangeStats);
  // Phase 2
  ipcMain.handle(REVIEW_CHECK_CONFLICT, handleCheckConflict);
  ipcMain.handle(REVIEW_REJECT_HUNKS, handleRejectHunks);
  ipcMain.handle(REVIEW_REJECT_FILE, handleRejectFile);
  ipcMain.handle(REVIEW_PREVIEW_REJECT, handlePreviewReject);
  ipcMain.handle(REVIEW_APPLY_DECISIONS, handleApplyDecisions);
  ipcMain.handle(REVIEW_EXECUTE_MUTATION, handleExecuteReviewMutation);
  ipcMain.handle(REVIEW_GET_FILE_CONTENT, handleGetFileContent);
  // Editable diff
  ipcMain.handle(REVIEW_SAVE_EDITED_FILE, handleSaveEditedFile);
  ipcMain.handle(REVIEW_DELETE_EDITED_FILE, handleDeleteEditedFile);
  ipcMain.handle(REVIEW_RESTORE_REJECTED_RENAME, handleRestoreRejectedRename);
  ipcMain.handle(REVIEW_REAPPLY_REJECTED_RENAME, handleReapplyRejectedRename);
  ipcMain.handle(REVIEW_WATCH_FILES, handleWatchReviewFiles);
  ipcMain.handle(REVIEW_UNWATCH_FILES, handleUnwatchReviewFiles);
  // Phase 4
  ipcMain.handle(REVIEW_GET_GIT_FILE_LOG, handleGetGitFileLog);
  // Decision persistence
  ipcMain.handle(REVIEW_LOAD_DECISIONS, handleLoadDecisions);
  ipcMain.handle(REVIEW_SAVE_DECISIONS, handleSaveDecisions);
  ipcMain.handle(REVIEW_CLEAR_DECISIONS, handleClearDecisions);
  ipcMain.handle(REVIEW_LOAD_DRAFT_HISTORY, handleLoadDraftHistory);
  ipcMain.handle(REVIEW_SAVE_DRAFT_HISTORY_ENTRY, handleSaveDraftHistoryEntry);
  ipcMain.handle(REVIEW_CLEAR_DRAFT_HISTORY, handleClearDraftHistory);
}

export function removeReviewHandlers(ipcMain: IpcMain): void {
  // Phase 1
  ipcMain.removeHandler(REVIEW_GET_AGENT_CHANGES);
  ipcMain.removeHandler(REVIEW_GET_TASK_CHANGES);
  ipcMain.removeHandler(REVIEW_GET_TEAM_TASK_CHANGE_SUMMARIES);
  ipcMain.removeHandler(REVIEW_INVALIDATE_TASK_CHANGE_SUMMARIES);
  ipcMain.removeHandler(REVIEW_GET_CHANGE_STATS);
  // Phase 2
  ipcMain.removeHandler(REVIEW_CHECK_CONFLICT);
  ipcMain.removeHandler(REVIEW_REJECT_HUNKS);
  ipcMain.removeHandler(REVIEW_REJECT_FILE);
  ipcMain.removeHandler(REVIEW_PREVIEW_REJECT);
  ipcMain.removeHandler(REVIEW_APPLY_DECISIONS);
  ipcMain.removeHandler(REVIEW_EXECUTE_MUTATION);
  ipcMain.removeHandler(REVIEW_GET_FILE_CONTENT);
  // Editable diff
  ipcMain.removeHandler(REVIEW_SAVE_EDITED_FILE);
  ipcMain.removeHandler(REVIEW_DELETE_EDITED_FILE);
  ipcMain.removeHandler(REVIEW_RESTORE_REJECTED_RENAME);
  ipcMain.removeHandler(REVIEW_REAPPLY_REJECTED_RENAME);
  ipcMain.removeHandler(REVIEW_WATCH_FILES);
  ipcMain.removeHandler(REVIEW_UNWATCH_FILES);
  // Phase 4
  ipcMain.removeHandler(REVIEW_GET_GIT_FILE_LOG);
  // Decision persistence
  ipcMain.removeHandler(REVIEW_LOAD_DECISIONS);
  ipcMain.removeHandler(REVIEW_SAVE_DECISIONS);
  ipcMain.removeHandler(REVIEW_CLEAR_DECISIONS);
  ipcMain.removeHandler(REVIEW_LOAD_DRAFT_HISTORY);
  ipcMain.removeHandler(REVIEW_SAVE_DRAFT_HISTORY_ENTRY);
  ipcMain.removeHandler(REVIEW_CLEAR_DRAFT_HISTORY);
  reviewFileWatcher.stop();
  reviewWatcherProjectRoot = null;
}

export function setReviewMainWindow(win: BrowserWindow | null): void {
  reviewMainWindowRef = win;
}

// --- Phase 1 Handlers ---

async function handleGetAgentChanges(
  _event: IpcMainInvokeEvent,
  teamName: string,
  memberName: string
): Promise<IpcResult<AgentChangeSet>> {
  return wrapReviewHandler('getAgentChanges', () =>
    getChangeExtractor().getAgentChanges(teamName, memberName)
  );
}

function sanitizeTaskChangeOptions(options?: unknown): TaskChangeRequestOptions | undefined {
  if (!options || typeof options !== 'object') {
    return undefined;
  }

  const raw = options as Record<string, unknown>;
  return {
    owner: typeof raw.owner === 'string' ? raw.owner : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    since: typeof raw.since === 'string' ? raw.since : undefined,
    intervals: Array.isArray(raw.intervals)
      ? (raw.intervals.filter(
          (i): i is { startedAt: string; completedAt?: string } =>
            Boolean(i) &&
            typeof i === 'object' &&
            typeof (i as Record<string, unknown>).startedAt === 'string' &&
            ((i as Record<string, unknown>).completedAt === undefined ||
              typeof (i as Record<string, unknown>).completedAt === 'string')
        ) as { startedAt: string; completedAt?: string }[])
      : undefined,
    stateBucket:
      raw.stateBucket === 'approved' ||
      raw.stateBucket === 'review' ||
      raw.stateBucket === 'completed' ||
      raw.stateBucket === 'active'
        ? raw.stateBucket
        : undefined,
    summaryOnly: raw.summaryOnly === true,
    forceFresh: raw.forceFresh === true,
  };
}

function sanitizeTeamTaskChangeSummaryRequests(requests: unknown): TeamTaskChangeSummaryRequest[] {
  if (!Array.isArray(requests)) {
    return [];
  }

  const sanitizedRequests: TeamTaskChangeSummaryRequest[] = [];
  const seenTaskIds = new Set<string>();
  for (const request of requests.slice(0, TEAM_TASK_CHANGE_SUMMARY_IPC_RAW_REQUEST_LIMIT)) {
    if (sanitizedRequests.length >= TEAM_TASK_CHANGE_SUMMARY_IPC_UNIQUE_REQUEST_LIMIT) {
      break;
    }
    if (!request || typeof request !== 'object') {
      continue;
    }
    const raw = request as Record<string, unknown>;
    if (typeof raw.taskId !== 'string') {
      continue;
    }
    const taskId = raw.taskId.trim();
    if (!taskId || seenTaskIds.has(taskId)) {
      continue;
    }
    seenTaskIds.add(taskId);
    sanitizedRequests.push({
      taskId,
      options: sanitizeTaskChangeOptions(raw.options),
    });
  }
  return sanitizedRequests;
}

async function handleGetTaskChanges(
  _event: IpcMainInvokeEvent,
  teamName: string,
  taskId: string,
  options?: unknown
): Promise<IpcResult<TaskChangeSetV2>> {
  const opts = sanitizeTaskChangeOptions(options);

  return wrapReviewHandler('getTaskChanges', () =>
    getChangeExtractor().getTaskChanges(teamName, taskId, opts)
  );
}

async function handleGetTeamTaskChangeSummaries(
  _event: IpcMainInvokeEvent,
  teamName: string,
  requests: unknown
): Promise<IpcResult<TeamTaskChangeSummariesResponse>> {
  const sanitizedRequests = sanitizeTeamTaskChangeSummaryRequests(requests);

  return wrapReviewHandler('getTeamTaskChangeSummaries', () =>
    getChangeExtractor().getTeamTaskChangeSummaries(teamName, sanitizedRequests)
  );
}

async function handleInvalidateTaskChangeSummaries(
  _event: IpcMainInvokeEvent,
  teamName: string,
  taskIds: string[]
): Promise<IpcResult<void>> {
  return wrapReviewHandler('invalidateTaskChangeSummaries', async () => {
    await getChangeExtractor().invalidateTaskChangeSummaries(
      teamName,
      Array.isArray(taskIds) ? taskIds.filter((taskId) => typeof taskId === 'string') : []
    );
  });
}

async function handleGetChangeStats(
  _event: IpcMainInvokeEvent,
  teamName: string,
  memberName: string
): Promise<IpcResult<ChangeStats>> {
  return wrapReviewHandler('getChangeStats', () =>
    getChangeExtractor().getChangeStats(teamName, memberName)
  );
}

// --- Phase 2 Handlers ---

async function handleCheckConflict(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  expectedModified: unknown
): Promise<IpcResult<ConflictCheckResult>> {
  return wrapReviewHandler('checkConflict', async () => {
    if (typeof expectedModified !== 'string') {
      throw new Error('Invalid expectedModified');
    }
    const { authorization } = await resolveReviewPathAuthorization(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    return getApplier().checkConflict(filePath, expectedModified);
  });
}

async function handleRejectHunks(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  hunkIndices: unknown
): Promise<IpcResult<RejectResult>> {
  return wrapReviewHandler('rejectHunks', async () => {
    assertHunkIndices(hunkIndices);
    const { scope, authorization } = await resolveReviewPathAuthorization(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const authoritativeContent = await resolveAuthoritativeFileContent(
      scope,
      authorization,
      filePath
    );
    if (
      authoritativeContent.originalFullContent === null ||
      authoritativeContent.modifiedFullContent === null
    ) {
      throw new Error('Authoritative review contents are unavailable');
    }
    return getApplier().rejectHunks(
      scope.teamName,
      filePath,
      authoritativeContent.originalFullContent,
      authoritativeContent.modifiedFullContent,
      hunkIndices,
      authoritativeContent.snippets
    );
  });
}

async function handleRejectFile(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown
): Promise<IpcResult<RejectResult>> {
  return wrapReviewHandler('rejectFile', async () => {
    const { scope, authorization } = await resolveReviewPathAuthorization(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const authoritativeContent = await resolveAuthoritativeFileContent(
      scope,
      authorization,
      filePath
    );
    if (
      authoritativeContent.originalFullContent === null ||
      authoritativeContent.modifiedFullContent === null
    ) {
      throw new Error('Authoritative review contents are unavailable');
    }
    return getApplier().rejectFile(
      scope.teamName,
      filePath,
      authoritativeContent.originalFullContent,
      authoritativeContent.modifiedFullContent
    );
  });
}

async function handlePreviewReject(
  _event: IpcMainInvokeEvent,
  filePath: string,
  original: string,
  modified: string,
  hunkIndices: number[],
  snippets: SnippetDiff[]
): Promise<IpcResult<{ preview: string; hasConflicts: boolean }>> {
  return wrapReviewHandler('previewReject', () =>
    getApplier().previewReject(filePath, original, modified, hunkIndices, snippets)
  );
}

async function handleApplyDecisions(
  _event: IpcMainInvokeEvent,
  requestValue: unknown
): Promise<IpcResult<ApplyReviewResult>> {
  if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
    return { success: false, error: 'Invalid request object' };
  }
  const request = requestValue as ApplyReviewRequest;
  if (!Array.isArray(request.decisions) || request.decisions.length > MAX_REVIEW_DECISIONS) {
    return { success: false, error: 'Invalid request: decisions array required' };
  }
  return wrapReviewHandler('applyDecisions', async () => {
    const { scope, authorization } = await resolveReviewPathAuthorization(request, {
      requireIdentity: true,
    });
    const persistenceScope = parseDecisionPersistenceScope(request.decisionPersistenceScope, scope);
    const validatedDecisions: FileReviewDecision[] = [];
    const fileContents = new Map<string, FileChangeWithContent>();
    for (const decision of request.decisions) {
      assertReviewDecisionShape(decision);
      const filePath = await validateAuthorizedReviewFilePath(authorization, decision.filePath, {
        requireReviewedFile: true,
        rejectHardlinks: true,
      });
      const authoritativeFile = getAuthoritativeReviewedFile(authorization, filePath);
      assertSnippetShapes(authoritativeFile.snippets);
      await validateSnippetPaths(authorization, authoritativeFile.snippets, {
        requireReviewedFile: true,
        rejectHardlinks: true,
      });
      const hasLedgerSnapshot = authoritativeFile.snippets.some(
        (snippet) => !!snippet.ledger && !snippet.isError
      );
      fileContents.set(
        filePath,
        hasLedgerSnapshot
          ? await resolveAuthoritativeFileContent(scope, authorization, filePath)
          : resolveDisplayedReviewSnapshot(
              decision.contentSnapshotToken,
              scope.teamName,
              filePath,
              authoritativeFile.snippets
            )
      );
      validatedDecisions.push({
        filePath,
        ...(decision.reviewKey ? { reviewKey: decision.reviewKey } : {}),
        fileDecision: decision.fileDecision,
        hunkDecisions: decision.hunkDecisions,
        ...(decision.hunkContextHashes ? { hunkContextHashes: decision.hunkContextHashes } : {}),
      });
    }
    const validatedRequest: ApplyReviewRequest = {
      teamName: scope.teamName,
      ...(scope.taskId ? { taskId: scope.taskId } : {}),
      ...(authorization.resolutionMemberName
        ? { memberName: authorization.resolutionMemberName }
        : {}),
      ...(persistenceScope ? { decisionPersistenceScope: persistenceScope } : {}),
      decisions: validatedDecisions,
    };

    let result: ApplyReviewResult;
    if (!persistenceScope) {
      result = await getApplier().applyReviewDecisions(validatedRequest, fileContents);
    } else {
      if (validatedDecisions.some((decision) => !decision.reviewKey)) {
        throw new Error('Durable review mutation requires a stable reviewKey');
      }
      if (!request.persistedState) {
        throw new Error('Durable review mutation requires an exact post-operation state');
      }
      if (
        !Number.isSafeInteger(request.expectedDecisionRevision) ||
        (request.expectedDecisionRevision as number) < 0
      ) {
        throw new Error('Durable review mutation requires an exact decision revision');
      }
      reviewDecisionStore.assertValidSnapshot(request.persistedState);
      assertPersistedStateIncludesDecisions(request.persistedState, validatedDecisions);
      result = await applyDecisionsWithDurableJournal(
        scope,
        persistenceScope,
        validatedDecisions as (FileReviewDecision & { reviewKey: string })[],
        fileContents,
        request.persistedState,
        request.expectedDecisionRevision as number
      );
    }

    // Invalidate resolved file content cache after applying decisions so subsequent
    // diff operations read the latest disk state (avoids "stuck" decisions in instant-apply flows).
    try {
      for (const d of validatedRequest.decisions) {
        getContentResolver().invalidateFile(d.filePath);
      }
    } catch (error) {
      logger.debug('applyDecisions cache invalidation failed:', error);
    }

    return result;
  });
}

class ReviewMutationApplyResultError extends Error {
  constructor(readonly result: ApplyReviewResult) {
    super(result.errors[0]?.error ?? 'Review mutation could not be applied safely');
  }
}

function assertPersistedStateIncludesDecisions(
  state: ReviewPersistedStateSnapshot,
  decisions: readonly FileReviewDecision[]
): void {
  for (const decision of decisions) {
    const reviewKey = decision.reviewKey;
    if (!reviewKey) throw new Error('Durable review mutation requires a stable reviewKey');
    const actualFileDecision =
      state.fileDecisions[reviewKey] ?? state.fileDecisions[decision.filePath] ?? 'pending';
    if (actualFileDecision !== decision.fileDecision) {
      throw new Error('Durable review state does not match the requested file decision');
    }
    for (const [index, expected] of Object.entries(decision.hunkDecisions)) {
      const actual =
        state.hunkDecisions[`${reviewKey}:${index}`] ??
        state.hunkDecisions[`${decision.filePath}:${index}`] ??
        'pending';
      if (actual !== expected) {
        throw new Error('Durable review state does not match the requested hunk decision');
      }
    }
  }
}

async function readReviewMutationPathPostimages(fileContent: FileChangeWithContent): Promise<{
  durable: ReviewMutationJournalPathPostimage[];
  contents: Map<string, string | null>;
}> {
  const paths = new Map<string, string>();
  for (const filePath of [fileContent.filePath, ...fileContent.snippets.map((s) => s.filePath)]) {
    paths.set(normalizeReviewPathForIdentity(filePath), filePath);
  }
  const durable: ReviewMutationJournalPathPostimage[] = [];
  const contents = new Map<string, string | null>();
  for (const filePath of paths.values()) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      contents.set(filePath, content);
      durable.push({ filePath, sha256: createHash('sha256').update(content).digest('hex') });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        contents.set(filePath, null);
        durable.push({ filePath, sha256: null });
      } else {
        throw error;
      }
    }
  }
  return { durable, contents };
}

async function assertReviewMutationPathPostimages(
  postimages: readonly ReviewMutationJournalPathPostimage[]
): Promise<void> {
  if (postimages.length === 0) {
    throw new Error('Applied review mutation has no durable postimage evidence');
  }
  for (const postimage of postimages) {
    let currentSha256: string | null;
    try {
      currentSha256 = createHash('sha256')
        .update(await fs.readFile(postimage.filePath, 'utf8'))
        .digest('hex');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') currentSha256 = null;
      else throw error;
    }
    if (currentSha256 !== postimage.sha256) {
      throw new Error(
        `Review mutation postimage changed after crash; refusing recovery for ${postimage.filePath}`
      );
    }
  }
}

function reconcileLatestReviewActionPostimages(
  state: ReviewPersistedStateSnapshot,
  postimages: ReadonlyMap<string, string | null>
): ReviewPersistedStateSnapshot {
  const latest = state.reviewActionHistory.at(-1);
  if (!latest) return state;
  const resolvePostimage = (filePath: string): string | null | undefined => {
    for (const [candidatePath, content] of postimages) {
      if (
        normalizeReviewPathForIdentity(candidatePath) === normalizeReviewPathForIdentity(filePath)
      ) {
        return content;
      }
    }
    return undefined;
  };

  let reconciled = latest;
  if (latest.kind === 'disk') {
    const snapshot = latest.action.snapshot;
    const actual = snapshot.renameExpectation ? undefined : resolvePostimage(snapshot.filePath);
    if (actual !== undefined) {
      reconciled = {
        ...latest,
        action: {
          ...latest.action,
          snapshot: { ...snapshot, afterContent: actual },
        },
      };
    }
  } else if (latest.kind === 'bulk') {
    reconciled = {
      ...latest,
      diskSnapshots: latest.diskSnapshots.map((snapshot) => {
        const actual = snapshot.renameExpectation ? undefined : resolvePostimage(snapshot.filePath);
        return actual === undefined ? snapshot : { ...snapshot, afterContent: actual };
      }),
    };
  }
  if (reconciled === latest) return state;
  return {
    ...state,
    reviewActionHistory: [...state.reviewActionHistory.slice(0, -1), reconciled],
  };
}

function mergeReviewApplyResults(
  current: ApplyReviewResult,
  next: ApplyReviewResult
): ApplyReviewResult {
  return {
    applied: current.applied + next.applied,
    skipped: current.skipped + next.skipped,
    conflicts: current.conflicts + next.conflicts,
    errors: [...current.errors, ...next.errors],
  };
}

async function applyJournalDecisionBatchDisk(
  record: ReviewMutationJournalRecord,
  onResult?: (result: ApplyReviewResult) => void
): Promise<ReviewMutationJournalRecord> {
  let current = record;
  let aggregate: ApplyReviewResult = { applied: 0, skipped: 0, conflicts: 0, errors: [] };
  const scope = parseReviewFileScope(current.reviewScope);
  const initialStatuses =
    current.decisionStatuses ?? current.decisions.map(() => 'pending' as const);

  try {
    for (const [index, status] of initialStatuses.entries()) {
      if (status !== 'applied') continue;
      const postimages = current.decisionPostimages?.[index];
      if (!postimages) {
        throw new Error('Applied review mutation is missing durable postimage evidence');
      }
      await assertReviewMutationPathPostimages(postimages);
    }
  } catch (error) {
    await reviewMutationJournal.markFailed(current, error).catch((journalError) => {
      logger.error('Unable to preserve drifted review mutation journal:', journalError);
    });
    throw error;
  }

  for (let index = 0; index < current.decisions.length; index++) {
    if (initialStatuses[index] === 'applied') continue;
    const decision = current.decisions[index];
    const fileContent = current.fileContents[index];
    if (!decision || !fileContent || fileContent.filePath !== decision.filePath) {
      throw new Error('Review mutation recovery content is unavailable');
    }

    let stepResult: ApplyReviewResult;
    try {
      stepResult = await getApplier().applyReviewDecisions(
        {
          teamName: current.teamName,
          ...(scope.taskId ? { taskId: scope.taskId } : {}),
          ...(scope.memberName ? { memberName: scope.memberName } : {}),
          decisions: [decision],
        },
        new Map([[decision.filePath, fileContent]])
      );
    } catch (error) {
      await reviewMutationJournal.markFailed(current, error).catch((journalError) => {
        logger.error('Unable to mark failed review mutation journal:', journalError);
      });
      throw error;
    }

    aggregate = mergeReviewApplyResults(aggregate, stepResult);
    onResult?.(aggregate);
    if (stepResult.errors.length > 0) {
      await reviewMutationJournal
        .markFailed(current, stepResult.errors[0]?.error)
        .catch((error) => {
          logger.error('Unable to preserve failed review mutation journal:', error);
        });
      throw new ReviewMutationApplyResultError(aggregate);
    }

    try {
      const decisionStatuses = [...(current.decisionStatuses ?? initialStatuses)];
      decisionStatuses[index] = 'applied';
      const pathPostimages = await readReviewMutationPathPostimages(fileContent);
      const decisionPostimages = [
        ...(current.decisionPostimages ?? current.decisions.map(() => null)),
      ];
      decisionPostimages[index] = pathPostimages.durable;
      let persistedState = current.persistedState;
      if (persistedState) {
        persistedState = reconcileLatestReviewActionPostimages(
          persistedState,
          pathPostimages.contents
        );
      }
      current = await reviewMutationJournal.checkpoint({
        ...current,
        decisionStatuses,
        decisionPostimages,
        persistedState,
      });
    } catch (error) {
      await reviewMutationJournal.markFailed(current, error).catch((journalError) => {
        logger.error('Unable to checkpoint review mutation postimage:', journalError);
      });
      throw error;
    }
    invalidateAuthoritativeReviewContent(fileContent);
  }

  return current;
}

async function commitReviewMutationDecisions(
  record: Awaited<ReturnType<ReviewMutationJournalStore['list']>>[number]
): Promise<void> {
  const { teamName, persistenceScope } = record;
  if (record.persistedState) {
    await reviewDecisionStore.save(teamName, persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      ...record.persistedState,
      expectedRevision: record.expectedDecisionRevision,
      mutationId: record.id,
    });
    return;
  }
  // Version-1 journal compatibility. Once recovered, the record is completed and removed.
  for (const decision of record.decisions) {
    await reviewDecisionStore.mergeFileDecisionPatch(
      teamName,
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      decision
    );
  }
}

async function assertCurrentReviewDecisionRevision(
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope,
  expectedRevision: number
): Promise<void> {
  const current = await reviewDecisionStore.load(
    teamName,
    persistenceScope.scopeKey,
    persistenceScope.scopeToken
  );
  if ((current?.revision ?? 0) !== expectedRevision) {
    throw new Error('Review decisions changed; refusing stale state overwrite');
  }
}

function toDurableReviewValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => toDurableReviewValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, toDurableReviewValue(entry)])
  );
}

function isDurableReviewEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(toDurableReviewValue(left), toDurableReviewValue(right));
}

function assertExactReviewHistoryTransition(
  request: ExecuteReviewMutationRequest,
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>
): void {
  if (request.kind !== 'undo' && request.kind !== 'redo') return;
  const next = request.persistedState;
  if (!Array.isArray(next.reviewActionHistory) || !Array.isArray(next.reviewRedoHistory)) {
    throw new Error('Review history transition is incomplete');
  }
  if (!current) {
    throw new Error(
      `Review history changed; refusing stale ${request.kind === 'undo' ? 'Undo' : 'Redo'}`
    );
  }

  if (request.kind === 'undo') {
    const action = current.reviewActionHistory.at(-1);
    if (!request.expectedTopActionId) {
      throw new Error('Review Undo requires the expected durable action id');
    }
    if (action?.id !== request.expectedTopActionId) {
      throw new Error('Review history changed; refusing stale Undo');
    }
    const redoEntry = next.reviewRedoHistory.at(-1);
    const transitionMatches =
      isDurableReviewEqual(next.reviewActionHistory, current.reviewActionHistory.slice(0, -1)) &&
      isDurableReviewEqual(next.reviewRedoHistory.slice(0, -1), current.reviewRedoHistory) &&
      isDurableReviewEqual(redoEntry?.action, action) &&
      isDurableReviewEqual(redoEntry?.decisionSnapshot, {
        hunkDecisions: current.hunkDecisions,
        fileDecisions: current.fileDecisions,
      }) &&
      isDurableReviewEqual(
        redoEntry?.hunkContextHashesByFile ?? {},
        current.hunkContextHashesByFile ?? {}
      );
    if (!transitionMatches) {
      throw new Error('Invalid durable Undo history transition');
    }
    return;
  }

  const redoEntry = current.reviewRedoHistory.at(-1);
  if (!request.expectedTopRedoActionId) {
    throw new Error('Review Redo requires the expected durable action id');
  }
  if (redoEntry?.action.id !== request.expectedTopRedoActionId) {
    throw new Error('Review history changed; refusing stale Redo');
  }
  const transitionMatches =
    isDurableReviewEqual(next.reviewRedoHistory, current.reviewRedoHistory.slice(0, -1)) &&
    isDurableReviewEqual(next.reviewActionHistory, [
      ...current.reviewActionHistory,
      redoEntry.action,
    ]) &&
    isDurableReviewEqual(next.hunkDecisions, redoEntry.decisionSnapshot.hunkDecisions) &&
    isDurableReviewEqual(next.fileDecisions, redoEntry.decisionSnapshot.fileDecisions) &&
    isDurableReviewEqual(
      next.hunkContextHashesByFile ?? {},
      redoEntry.hunkContextHashesByFile ?? current.hunkContextHashesByFile ?? {}
    );
  if (!transitionMatches) {
    throw new Error('Invalid durable Redo history transition');
  }
}

async function applyDecisionsWithDurableJournal(
  scope: ReviewFileScope,
  persistenceScope: ReviewDecisionPersistenceScope,
  decisions: (FileReviewDecision & { reviewKey: string })[],
  fileContents: Map<string, FileChangeWithContent>,
  persistedState: ReviewPersistedStateSnapshot,
  expectedDecisionRevision: number
): Promise<ApplyReviewResult> {
  return withReviewDecisionPersistenceLock(scope.teamName, persistenceScope, async () => {
    try {
      await recoverReviewMutationJournal(scope.teamName, persistenceScope);
      await assertCurrentReviewDecisionRevision(
        scope.teamName,
        persistenceScope,
        expectedDecisionRevision
      );
      let result: ApplyReviewResult | null = null;
      await reviewMutationCoordinator.execute(
        {
          teamName: scope.teamName,
          persistenceScope,
          reviewScope: scope,
          kind: decisions.length > 1 ? 'bulk' : 'reject',
          decisions,
          fileContents: decisions.map((decision) => {
            const content = fileContents.get(decision.filePath);
            if (!content) throw new Error('Review mutation content is unavailable');
            return content;
          }),
          persistedState,
          expectedDecisionRevision,
        },
        {
          applyDisk: (record) =>
            applyJournalDecisionBatchDisk(record, (nextResult) => {
              result = nextResult;
            }),
          commitDecisions: commitReviewMutationDecisions,
        }
      );
      const committed = await reviewDecisionStore.load(
        scope.teamName,
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      );
      return {
        ...(result ?? { applied: 0, skipped: 0, conflicts: 0, errors: [] }),
        decisionRevision: committed?.revision ?? expectedDecisionRevision,
      };
    } catch (error) {
      if (error instanceof ReviewMutationApplyResultError) return error.result;
      throw error;
    }
  });
}

async function normalizeDirectReviewMutationSteps(
  request: ExecuteReviewMutationRequest,
  scope: ReviewFileScope,
  authorization: ReviewPathAuthorization
): Promise<ReviewMutationJournalDiskStep[]> {
  const ids = new Set<string>();
  const normalized: ReviewMutationJournalDiskStep[] = [];
  for (const step of request.diskSteps) {
    if (
      !step ||
      typeof step.id !== 'string' ||
      step.id.length === 0 ||
      step.id.length > 256 ||
      ids.has(step.id)
    ) {
      throw new Error('Invalid or duplicate review mutation step id');
    }
    ids.add(step.id);
    const filePath = await validateAuthorizedReviewFilePath(authorization, step.filePath, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    if (step.type === 'write') {
      if (
        typeof step.content !== 'string' ||
        (step.expectedContent !== null && typeof step.expectedContent !== 'string')
      ) {
        throw new Error('Invalid review write mutation');
      }
      normalized.push({ ...step, filePath, status: 'pending' });
      continue;
    }
    if (step.type === 'delete') {
      if (typeof step.expectedContent !== 'string') {
        throw new Error('Invalid review delete mutation');
      }
      normalized.push({ ...step, filePath, status: 'pending' });
      continue;
    }
    if (step.type !== 'restore-rejected-rename' && step.type !== 'reapply-rejected-rename') {
      throw new Error('Invalid review mutation step');
    }
    const expectation = parseReviewRenameRecoveryExpectation(step.expectation);
    const authoritativeContent = await resolveAuthoritativeFileContent(
      scope,
      authorization,
      filePath
    );
    await validateSnippetPaths(authorization, authoritativeContent.snippets, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    assertExpectedAuthoritativeRename(authoritativeContent, expectation);
    normalized.push({
      ...step,
      filePath,
      expectation,
      authoritativeContent,
      status: 'pending',
    });
  }
  return normalized;
}

type DirectReviewMutationState = 'before' | 'after' | 'both' | 'intermediate';

async function classifyDirectReviewMutationStep(
  step: ReviewMutationJournalDiskStep
): Promise<DirectReviewMutationState> {
  if (step.type === 'write') {
    return getApplier().classifyEditedFileTransition(
      step.filePath,
      step.expectedContent,
      step.content
    );
  }
  if (step.type === 'delete') {
    return getApplier().classifyEditedFileTransition(step.filePath, step.expectedContent, null);
  }
  const content = step.authoritativeContent;
  if (!content) throw new Error('Rename recovery content is unavailable');
  const state = await getApplier().classifyRejectedRenameTransition(
    step.filePath,
    content.originalFullContent,
    content.modifiedFullContent,
    content.snippets
  );
  if (state === 'both') return 'both';
  const beforeState = step.type === 'restore-rejected-rename' ? 'rejected' : 'accepted';
  const afterState = step.type === 'restore-rejected-rename' ? 'accepted' : 'rejected';
  if (state === beforeState) return 'before';
  if (state === afterState) return 'after';
  const recoverableIntermediate =
    (step.type === 'restore-rejected-rename' && state === 'restoring') ||
    (step.type === 'reapply-rejected-rename' &&
      (state === 'reapplying' || state === 'legacy-reapplying'));
  if (recoverableIntermediate) return 'intermediate';
  throw new Error('Ledger rename is not in the expected durable mutation state');
}

async function assertDirectReviewMutationPreimages(
  steps: readonly ReviewMutationJournalDiskStep[]
): Promise<void> {
  for (const step of steps) {
    const state = await classifyDirectReviewMutationStep(step);
    if (state !== 'before' && state !== 'both') {
      throw new Error('Review mutation preflight failed; no files were changed');
    }
  }
}

async function applyDirectReviewMutationDisk(
  record: ReviewMutationJournalRecord
): Promise<ReviewMutationJournalRecord> {
  let current = record;
  const steps = current.diskSteps;
  if (!steps?.length) return current;

  try {
    const alreadyAtPostimage = new Set<number>();
    for (const [index, step] of steps.entries()) {
      const state = await classifyDirectReviewMutationStep(step);
      if (step.status === 'applied') {
        if (state !== 'after' && state !== 'both') {
          throw new Error('Applied review mutation changed after crash; refusing recovery');
        }
      } else if (state === 'after' || state === 'both') {
        alreadyAtPostimage.add(index);
      }
    }
    if (alreadyAtPostimage.size > 0) {
      current = await reviewMutationJournal.checkpoint({
        ...current,
        diskSteps: current.diskSteps!.map((step, index) =>
          alreadyAtPostimage.has(index) ? { ...step, status: 'applied' as const } : step
        ),
      });
    }
  } catch (error) {
    await reviewMutationJournal.markFailed(current, error).catch((journalError) => {
      logger.error('Unable to preserve drifted direct review mutation:', journalError);
    });
    throw error;
  }

  for (let index = 0; index < steps.length; index++) {
    const step = current.diskSteps?.[index];
    if (!step || step.status === 'applied') continue;
    try {
      if (step.type === 'write') {
        await getApplier().saveEditedFile(step.filePath, step.content, step.expectedContent);
      } else if (step.type === 'delete') {
        await getApplier().deleteEditedFile(step.filePath, step.expectedContent);
      } else {
        const content = step.authoritativeContent;
        if (!content) throw new Error('Rename recovery content is unavailable');
        if (step.type === 'restore-rejected-rename') {
          await getApplier().restoreRejectedRename(
            step.filePath,
            content.originalFullContent,
            content.modifiedFullContent,
            content.snippets
          );
        } else {
          await getApplier().reapplyRejectedRename(
            step.filePath,
            content.originalFullContent,
            content.snippets
          );
        }
      }
      const postState = await classifyDirectReviewMutationStep(step);
      if (postState !== 'after' && postState !== 'both') {
        throw new Error('Review mutation did not reach its durable postimage');
      }
    } catch (error) {
      await reviewMutationJournal.markFailed(current, error).catch((journalError) => {
        logger.error('Unable to mark failed direct review mutation:', journalError);
      });
      throw error;
    }
    const nextSteps = current.diskSteps!.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...candidate, status: 'applied' as const } : candidate
    );
    current = await reviewMutationJournal.checkpoint({ ...current, diskSteps: nextSteps });
    if (step.authoritativeContent) {
      invalidateAuthoritativeReviewContent(step.authoritativeContent);
    } else {
      getContentResolver().invalidateFile(step.filePath);
    }
  }
  return current;
}

async function handleExecuteReviewMutation(
  _event: IpcMainInvokeEvent,
  requestValue: unknown
): Promise<IpcResult<{ decisionRevision: number }>> {
  if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
    return { success: false, error: 'Invalid review mutation request' };
  }
  const request = requestValue as ExecuteReviewMutationRequest;
  const isHistoryMutation = request.kind === 'undo' || request.kind === 'redo';
  if (
    (request.kind !== 'restore' &&
      request.kind !== 'rename' &&
      request.kind !== 'undo' &&
      request.kind !== 'redo') ||
    !Array.isArray(request.diskSteps) ||
    (!isHistoryMutation && request.diskSteps.length === 0) ||
    request.diskSteps.length > MAX_REVIEW_MUTATION_STEPS
  ) {
    return { success: false, error: 'Invalid review mutation request' };
  }
  return wrapReviewHandler('executeMutation', async () => {
    const { scope, authorization } = await resolveReviewPathAuthorization(request.scope, {
      requireIdentity: true,
    });
    const persistenceScope = parseDecisionPersistenceScope(request.decisionPersistenceScope, scope);
    if (!persistenceScope) throw new Error('Review mutation requires an exact decision scope');
    reviewDecisionStore.assertValidSnapshot(request.persistedState);
    if (
      !Number.isSafeInteger(request.expectedDecisionRevision) ||
      request.expectedDecisionRevision < 0
    ) {
      throw new Error('Review mutation requires an exact decision revision');
    }

    return withReviewDecisionPersistenceLock(scope.teamName, persistenceScope, async () => {
      await recoverReviewMutationJournal(scope.teamName, persistenceScope);
      await assertCurrentReviewDecisionRevision(
        scope.teamName,
        persistenceScope,
        request.expectedDecisionRevision
      );
      const current = await reviewDecisionStore.load(
        scope.teamName,
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      );
      assertExactReviewHistoryTransition(request, current);
      // Recovery can change disk state and invalidate authoritative review content.
      // Resolve this operation only after every older WAL record is complete.
      const diskSteps = await normalizeDirectReviewMutationSteps(request, scope, authorization);
      await assertDirectReviewMutationPreimages(diskSteps);
      await reviewMutationCoordinator.execute(
        {
          teamName: scope.teamName,
          persistenceScope,
          reviewScope: scope,
          kind: request.kind,
          decisions: [],
          fileContents: [],
          diskSteps,
          persistedState: request.persistedState,
          expectedDecisionRevision: request.expectedDecisionRevision,
        },
        {
          applyDisk: applyDirectReviewMutationDisk,
          commitDecisions: commitReviewMutationDecisions,
        }
      );
      const committed = await reviewDecisionStore.load(
        scope.teamName,
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      );
      return { decisionRevision: committed?.revision ?? request.expectedDecisionRevision };
    });
  });
}

async function handleGetFileContent(
  _event: IpcMainInvokeEvent,
  teamNameValue: unknown,
  memberNameValue: unknown,
  filePathValue: unknown,
  snippetsValue: unknown = []
): Promise<IpcResult<FileChangeWithContent>> {
  return wrapReviewHandler('getFileContent', async () => {
    assertOptionalString(memberNameValue, 'memberName');
    assertSnippetShapes(snippetsValue);
    const { scope, authorization } = await resolveReviewPathAuthorization({
      teamName: teamNameValue,
      memberName: normalizeReviewIdentity(memberNameValue),
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: false,
    });
    await validateSnippetPaths(authorization, snippetsValue);
    const content = await getContentResolver().getFileContent(
      scope.teamName,
      scope.memberName ?? '',
      filePath,
      snippetsValue
    );
    return registerDisplayedReviewSnapshot(scope.teamName, filePath, snippetsValue, content);
  });
}

// --- Editable diff Handlers ---

async function handleSaveEditedFile(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  content: unknown,
  expectedCurrentContent: string | null | undefined
): Promise<IpcResult<{ success: boolean }>> {
  if (
    typeof filePathValue !== 'string' ||
    typeof content !== 'string' ||
    (expectedCurrentContent !== null && typeof expectedCurrentContent !== 'string')
  ) {
    return { success: false, error: 'Invalid parameters' };
  }
  return wrapReviewHandler('saveEditedFile', async () => {
    const { authorization } = await resolveReviewPathAuthorization(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const result = await getApplier().saveEditedFile(filePath, content, expectedCurrentContent);
    // Invalidate cached content so next fetch reads the saved version from disk
    getContentResolver().invalidateFile(filePath);
    return result;
  });
}

async function handleDeleteEditedFile(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  expectedCurrentContent: unknown
): Promise<IpcResult<{ success: boolean }>> {
  if (typeof expectedCurrentContent !== 'string') {
    return { success: false, error: 'Invalid parameters' };
  }
  return wrapReviewHandler('deleteEditedFile', async () => {
    const { authorization } = await resolveReviewPathAuthorization(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const result = await getApplier().deleteEditedFile(filePath, expectedCurrentContent);
    getContentResolver().invalidateFile(filePath);
    return result;
  });
}

async function handleRestoreRejectedRename(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  expectationValue: unknown
): Promise<IpcResult<{ success: boolean }>> {
  return wrapReviewHandler('restoreRejectedRename', async () => {
    const expectation = parseReviewRenameRecoveryExpectation(expectationValue);
    const { scope, authorization } = await resolveReviewPathAuthorization(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const authoritativeContent = await resolveAuthoritativeFileContent(
      scope,
      authorization,
      filePath
    );
    await validateSnippetPaths(authorization, authoritativeContent.snippets, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    assertExpectedAuthoritativeRename(authoritativeContent, expectation);

    try {
      return await getApplier().restoreRejectedRename(
        filePath,
        authoritativeContent.originalFullContent,
        authoritativeContent.modifiedFullContent,
        authoritativeContent.snippets
      );
    } finally {
      invalidateAuthoritativeReviewContent(authoritativeContent);
    }
  });
}

async function handleReapplyRejectedRename(
  _event: IpcMainInvokeEvent,
  scopeValue: unknown,
  filePathValue: unknown,
  expectationValue: unknown
): Promise<IpcResult<{ success: boolean }>> {
  return wrapReviewHandler('reapplyRejectedRename', async () => {
    const expectation = parseReviewRenameRecoveryExpectation(expectationValue);
    const { scope, authorization } = await resolveReviewPathAuthorization(scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const authoritativeContent = await resolveAuthoritativeFileContent(
      scope,
      authorization,
      filePath
    );
    await validateSnippetPaths(authorization, authoritativeContent.snippets, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    assertExpectedAuthoritativeRename(authoritativeContent, expectation);

    try {
      return await getApplier().reapplyRejectedRename(
        filePath,
        authoritativeContent.originalFullContent,
        authoritativeContent.snippets
      );
    } finally {
      invalidateAuthoritativeReviewContent(authoritativeContent);
    }
  });
}

async function handleWatchReviewFiles(
  _event: IpcMainInvokeEvent,
  projectPath: string,
  filePaths: string[]
): Promise<IpcResult<void>> {
  return wrapReviewHandler('watchFiles', async () => {
    const normalizedProjectPath = await validateReviewProjectPath(projectPath);
    const shouldRestart =
      reviewWatcherProjectRoot !== normalizedProjectPath || !reviewFileWatcher.isWatching();

    if (shouldRestart) {
      reviewFileWatcher.stop();
      reviewWatcherProjectRoot = normalizedProjectPath;
      reviewFileWatcher.start(normalizedProjectPath, (event) => {
        safeSendToRenderer(reviewMainWindowRef, REVIEW_FILE_CHANGE, event);
      });
    }

    reviewFileWatcher.setWatchedFiles(Array.isArray(filePaths) ? filePaths : []);
  });
}

async function handleUnwatchReviewFiles(): Promise<IpcResult<void>> {
  return wrapReviewHandler('unwatchFiles', async () => {
    reviewFileWatcher.stop();
    reviewWatcherProjectRoot = null;
  });
}

// --- Phase 4 Handlers ---

async function validateReviewProjectPath(projectPath: string): Promise<string> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('Invalid project path');
  }

  if (!path.isAbsolute(projectPath)) {
    throw new Error('Project path must be absolute');
  }

  const normalized = path.resolve(path.normalize(projectPath));
  const stat = await fs.stat(normalized);
  if (!stat.isDirectory()) {
    throw new Error('Project path is not a directory');
  }
  return normalized;
}

async function handleGetGitFileLog(
  _event: IpcMainInvokeEvent,
  projectPath: string,
  filePath: string
): Promise<IpcResult<{ hash: string; timestamp: string; message: string }[]>> {
  return wrapReviewHandler('getGitFileLog', async () => {
    if (!gitDiffFallback) {
      return [];
    }
    return gitDiffFallback.getFileLog(projectPath, filePath);
  });
}

// --- Decision Persistence Handlers ---

function assertRecoverableJournalContent(
  record: Awaited<ReturnType<ReviewMutationJournalStore['list']>>[number]
): void {
  if (
    record.persistedState &&
    (!Number.isSafeInteger(record.expectedDecisionRevision) ||
      (record.expectedDecisionRevision as number) < 0)
  ) {
    throw new Error('Review mutation recovery revision is unavailable');
  }
  if (record.diskSteps?.length) {
    if (!record.persistedState) {
      throw new Error('Review mutation recovery state is unavailable');
    }
    reviewDecisionStore.assertValidSnapshot(record.persistedState);
    return;
  }
  if (
    (record.kind === 'undo' || record.kind === 'redo') &&
    record.decisions.length === 0 &&
    record.fileContents.length === 0 &&
    record.persistedState
  ) {
    reviewDecisionStore.assertValidSnapshot(record.persistedState);
    return;
  }
  if (record.decisions.length === 0 || record.decisions.length !== record.fileContents.length) {
    throw new Error('Invalid review mutation recovery batch');
  }
  for (const [index, decision] of record.decisions.entries()) {
    const fileContent = record.fileContents[index];
    assertReviewDecisionShape(decision);
    assertSnippetShapes(fileContent?.snippets);
    if (
      !fileContent ||
      fileContent.filePath !== decision.filePath ||
      (fileContent.originalFullContent !== null &&
        typeof fileContent.originalFullContent !== 'string') ||
      (fileContent.modifiedFullContent !== null &&
        typeof fileContent.modifiedFullContent !== 'string') ||
      typeof fileContent.isNewFile !== 'boolean'
    ) {
      throw new Error('Invalid review mutation recovery content');
    }
  }
}

async function recoverReviewMutationJournal(
  teamName: string,
  persistenceScope: ReviewDecisionPersistenceScope
): Promise<void> {
  const records = await reviewMutationJournal.list(teamName, persistenceScope);
  for (const record of records) {
    if (record.blocked) {
      throw new Error(
        'A previous review update did not finish safely. Retry recovery or discard saved review state.'
      );
    }
    assertRecoverableJournalContent(record);
    const parsedScope = parseReviewFileScope(record.reviewScope);
    if (!parsedScope.taskId && !parsedScope.memberName) {
      throw new Error('Review mutation recovery requires taskId or memberName');
    }
    const scope = parsedScope;
    if (scope.teamName !== teamName) {
      throw new Error('Review mutation recovery scope mismatch');
    }
    parseDecisionPersistenceScope(persistenceScope, scope);
    if (
      !record.diskSteps?.length &&
      record.decisions.length === 0 &&
      (record.kind === 'undo' || record.kind === 'redo')
    ) {
      await reviewMutationCoordinator.resume(record, {
        applyDisk: applyDirectReviewMutationDisk,
        commitDecisions: commitReviewMutationDecisions,
      });
      continue;
    }
    if (record.diskSteps?.length) {
      const { authorization } = await resolveReviewPathAuthorization(scope, {
        requireIdentity: true,
      });
      for (const step of record.diskSteps) {
        const filePath = await validateAuthorizedReviewFilePath(authorization, step.filePath, {
          requireReviewedFile: false,
          rejectHardlinks: true,
        });
        if (filePath !== path.resolve(path.normalize(step.filePath))) {
          throw new Error('Review mutation recovery file mismatch');
        }
        if (step.authoritativeContent) {
          await validateSnippetPaths(authorization, step.authoritativeContent.snippets, {
            requireReviewedFile: false,
            rejectHardlinks: true,
          });
        }
      }
      await reviewMutationCoordinator.resume(record, {
        applyDisk: applyDirectReviewMutationDisk,
        commitDecisions: commitReviewMutationDecisions,
      });
      continue;
    }
    await reviewMutationCoordinator.resume(record, {
      applyDisk: async (current) => {
        const { authorization } = await resolveReviewPathAuthorization(scope, {
          requireIdentity: true,
        });
        for (const [index, savedDecision] of current.decisions.entries()) {
          const savedContent = current.fileContents[index];
          const filePath = await validateAuthorizedReviewFilePath(
            authorization,
            savedDecision.filePath,
            { requireReviewedFile: false, rejectHardlinks: true }
          );
          await validateSnippetPaths(authorization, savedContent.snippets, {
            requireReviewedFile: false,
            rejectHardlinks: true,
          });
          if (filePath !== path.resolve(path.normalize(savedContent.filePath))) {
            throw new Error('Review mutation recovery file mismatch');
          }
        }
        return applyJournalDecisionBatchDisk(current);
      },
      commitDecisions: commitReviewMutationDecisions,
    });
  }
}

async function handleLoadDecisions(
  _event: IpcMainInvokeEvent,
  teamName: string,
  scopeKey: string,
  scopeToken: string | null = null
): Promise<
  IpcResult<{
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
    reviewActionHistory: ReviewUndoAction[];
    reviewRedoHistory: ReviewRedoAction[];
    revision: number;
  } | null>
> {
  return wrapReviewHandler('loadDecisions', async () => {
    if (!scopeToken) {
      return reviewDecisionStore.load(teamName, scopeKey);
    }
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(teamName, persistenceScope, async () => {
      await recoverReviewMutationJournal(teamName, persistenceScope);
      return reviewDecisionStore.load(teamName, scopeKey, scopeToken);
    });
  });
}

async function handleSaveDecisions(
  _event: IpcMainInvokeEvent,
  teamName: string,
  scopeKey: string,
  scopeToken: string,
  hunkDecisions: Record<string, HunkDecision>,
  fileDecisions: Record<string, HunkDecision>,
  hunkContextHashesByFile: Record<string, Record<number, string>> | null = null,
  reviewActionHistory: ReviewUndoAction[] = [],
  expectedRevision: number | undefined = undefined,
  reviewRedoHistory: ReviewRedoAction[] = []
): Promise<IpcResult<{ revision: number }>> {
  return wrapReviewHandler('saveDecisions', async () => {
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) {
      throw new Error('Saving review decisions requires an exact decision revision');
    }
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(teamName, persistenceScope, async () => {
      await recoverReviewMutationJournal(teamName, persistenceScope);
      const revision = await reviewDecisionStore.save(teamName, scopeKey, {
        scopeToken,
        hunkDecisions,
        fileDecisions,
        hunkContextHashesByFile: hunkContextHashesByFile ?? undefined,
        reviewActionHistory,
        reviewRedoHistory,
        expectedRevision: expectedRevision as number,
      });
      return { revision };
    });
  });
}

async function handleClearDecisions(
  _event: IpcMainInvokeEvent,
  teamName: string,
  scopeKey: string,
  scopeToken: string | null = null,
  expectedRevision: number | undefined = undefined
): Promise<IpcResult<{ revision: number }>> {
  return wrapReviewHandler('clearDecisions', async () => {
    if (!scopeToken) {
      await reviewDecisionStore.clear(teamName, scopeKey);
      return { revision: 0 };
    }
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(teamName, persistenceScope, async () => {
      if (expectedRevision === undefined) {
        // Only the explicit "discard unreadable state" UI uses this recovery escape hatch.
        await reviewMutationJournal.clearScope(teamName, persistenceScope);
        await reviewDecisionStore.clear(teamName, scopeKey, scopeToken);
        return { revision: 0 };
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('Clearing review decisions requires an exact decision revision');
      }
      await recoverReviewMutationJournal(teamName, persistenceScope);
      const revision = await reviewDecisionStore.save(teamName, scopeKey, {
        scopeToken,
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
        expectedRevision,
      });
      return { revision };
    });
  });
}

async function handleLoadDraftHistory(
  _event: IpcMainInvokeEvent,
  teamName: string,
  scopeKey: string,
  scopeToken: string
): Promise<IpcResult<ReviewDraftHistorySnapshot | null>> {
  return wrapReviewHandler('loadDraftHistory', async () => {
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(teamName, persistenceScope, () =>
      reviewDraftHistoryStore.load(teamName, scopeKey, scopeToken)
    );
  });
}

async function handleSaveDraftHistoryEntry(
  _event: IpcMainInvokeEvent,
  teamName: string,
  scopeKey: string,
  scopeToken: string,
  entry: Omit<ReviewDraftHistoryEntry, 'updatedAt'>
): Promise<IpcResult<ReviewDraftHistoryEntry>> {
  return wrapReviewHandler('saveDraftHistoryEntry', async () => {
    const persistenceScope = { scopeKey, scopeToken };
    return withReviewDecisionPersistenceLock(teamName, persistenceScope, () =>
      reviewDraftHistoryStore.saveEntry(teamName, scopeKey, scopeToken, entry)
    );
  });
}

async function handleClearDraftHistory(
  _event: IpcMainInvokeEvent,
  teamName: string,
  scopeKey: string,
  scopeToken: string,
  filePath: string | null = null
): Promise<IpcResult<void>> {
  return wrapReviewHandler('clearDraftHistory', async () => {
    const persistenceScope = { scopeKey, scopeToken };
    await withReviewDecisionPersistenceLock(teamName, persistenceScope, async () => {
      if (filePath !== null) {
        await reviewDraftHistoryStore.clearEntry(teamName, scopeKey, scopeToken, filePath);
      } else {
        await reviewDraftHistoryStore.clearScope(teamName, scopeKey, scopeToken);
      }
    });
  });
}
