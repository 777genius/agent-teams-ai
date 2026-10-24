import { hasUnqualifiedNativeChain } from '../../nativeCaptureProof.js';
import type { ReviewConfiguredTeam, ReviewWriterContext } from './ports.js';
import type { AuthorizedReviewRoot, ReviewPathAuthorization } from './displayedSnapshots.js';
import type {
  FileChangeSummary,
  ReviewFileScope,
  FileChangeWithContent,
  ReviewRenameRecoveryExpectation,
} from '../../contracts.js';
import {
  parseReviewFileScope,
  normalizeReviewIdentity,
  assertNonEmptyString,
  assertSnippetShapes,
  validateSnippetPaths,
} from './validation.js';
import { matchesSensitivePattern, isPathWithinRoot } from './reviewGuards.js';
import { cleanupAtomicCreateTempLinks, isOwnedReviewFileTransactionHardlink } from '../io/index.js';

import * as path from 'path';

import * as fs from 'fs/promises';

export function collectConfiguredReviewRoots(config: ReviewConfiguredTeam): string[] {
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

export async function resolveAuthorizedReviewRoot(
  rootPath: string
): Promise<AuthorizedReviewRoot | null> {
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

export function normalizeReviewPathForIdentity(filePath: string): string {
  const normalized = path.resolve(path.normalize(filePath));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

export function collectAuthoritativeReviewedFiles(
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

export async function resolveReviewPathAuthorization(
  env: Pick<ReviewWriterContext, 'assertActive' | 'authorization' | 'changes'>,
  scopeValue: unknown,
  options: {
    requireIdentity?: boolean;
  } = {}
): Promise<{
  scope: ReviewFileScope;
  authorization: ReviewPathAuthorization;
}> {
  const scope = parseReviewFileScope(scopeValue);
  if (options.requireIdentity && !scope.taskId && !scope.memberName) {
    throw new Error('Review mutation requires taskId or memberName');
  }
  const config = await (env.assertActive(), env.authorization.getConfig(scope.teamName));
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
    const changeSet = await (env.assertActive(),
    env.changes.getTaskChanges(scope.teamName, scope.taskId));
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
    const changeSet = await (env.assertActive(),
    env.changes.getAgentChanges(scope.teamName, scope.memberName));
    reviewedFiles = collectAuthoritativeReviewedFiles(changeSet.files);
  }
  return { scope, authorization: { roots, reviewedFiles, resolutionMemberName } };
}

export async function resolveNearestExistingRealPath(filePath: string): Promise<string> {
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

export async function validateAuthorizedReviewFilePath(
  authorization: ReviewPathAuthorization,
  filePathValue: unknown,
  options: {
    requireReviewedFile: boolean;
    rejectHardlinks?: boolean;
  }
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
  const reviewed = authorization.reviewedFiles?.get(normalizeReviewPathForIdentity(normalizedPath));
  if (reviewed && hasUnqualifiedNativeChain(reviewed.snippets))
    throw new Error('Native file attribution is unqualified; review mutation refused');
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
    const ownedReviewTransactionLink =
      !targetStat.isSymbolicLink() &&
      resolvedStat.nlink > 1 &&
      (await isOwnedReviewFileTransactionHardlink(normalizedPath));
    if (targetStat.isSymbolicLink() || (resolvedStat.nlink > 1 && !ownedReviewTransactionLink)) {
      throw new Error('Review mutation refuses symbolic or multiply-linked files');
    }
  }
  return normalizedPath;
}

export function getAuthoritativeReviewedFile(
  authorization: ReviewPathAuthorization,
  filePath: string
): FileChangeSummary {
  const file = authorization.reviewedFiles?.get(normalizeReviewPathForIdentity(filePath));
  if (!file) {
    throw new Error('File is not part of the reviewed scope');
  }
  if (hasUnqualifiedNativeChain(file.snippets))
    throw new Error('Native file attribution is unqualified; review mutation refused');
  return file;
}

export async function resolveAuthoritativeFileContent(
  env: Pick<ReviewWriterContext, 'assertActive' | 'content'>,
  scope: ReviewFileScope,
  authorization: ReviewPathAuthorization,
  filePath: string
): Promise<FileChangeWithContent> {
  const authoritativeFile = getAuthoritativeReviewedFile(authorization, filePath);
  assertSnippetShapes(authoritativeFile.snippets);
  await validateSnippetPaths(authorization, authoritativeFile.snippets, {
    requireReviewedFile: true,
  });
  const resolved = await (env.assertActive(),
  env.content.getFileContent(
    scope.teamName,
    authorization.resolutionMemberName,
    filePath,
    authoritativeFile.snippets
  ));
  return {
    ...resolved,
    filePath,
    snippets: authoritativeFile.snippets,
  };
}

export function assertExpectedAuthoritativeRename(
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

export function invalidateAuthoritativeReviewContent(
  env: Pick<ReviewWriterContext, 'assertActive' | 'content'>,
  content: FileChangeWithContent
): void {
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
    env.assertActive();
    env.content.invalidateFile(filePath);
  }
}
