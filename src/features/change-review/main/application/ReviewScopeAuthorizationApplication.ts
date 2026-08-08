import {
  assertExpectedAuthoritativeRename,
  assertNonEmptyString,
  assertSnippetShapes,
  collectReviewRootCandidates,
  normalizeReviewIdentity,
  parseReviewFileScope,
  parseReviewRenameRecoveryExpectation,
} from '../../core/domain/reviewScopePolicy';

import type {
  AuthorizedReviewRoot,
  ReviewPathAuthorization,
  ReviewScopeAuthorizationDependencies,
} from './ReviewScopeAuthorizationPorts';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  ReviewFileScope,
  ReviewRenameRecoveryExpectation,
  SnippetDiff,
} from '@shared/types/review';

export class ReviewScopeAuthorizationApplication {
  constructor(private readonly dependencies: ReviewScopeAuthorizationDependencies) {}

  normalizeReviewIdentity(value: string | undefined): string | undefined {
    return normalizeReviewIdentity(value);
  }

  parseReviewFileScope(value: unknown): ReviewFileScope {
    return parseReviewFileScope(value, this.dependencies.validators);
  }

  parseReviewRenameRecoveryExpectation(value: unknown): ReviewRenameRecoveryExpectation {
    return parseReviewRenameRecoveryExpectation(value);
  }

  normalizeReviewPathForIdentity(filePath: string): string {
    return this.dependencies.paths.normalizeIdentity(filePath);
  }

  async resolveReviewPathAuthorization(
    scopeValue: unknown,
    options: { requireIdentity?: boolean } = {}
  ): Promise<{ scope: ReviewFileScope; authorization: ReviewPathAuthorization }> {
    const scope = this.parseReviewFileScope(scopeValue);
    if (options.requireIdentity && !scope.taskId && !scope.memberName) {
      throw new Error('Review mutation requires taskId or memberName');
    }
    const config = await this.dependencies.config.getConfig(scope.teamName);
    if (!config) {
      throw new Error(`Review team config is unavailable: ${scope.teamName}`);
    }

    const rootCandidates = [
      ...new Set(
        collectReviewRootCandidates(config).map((root) => this.dependencies.paths.normalize(root))
      ),
    ];
    const roots = (
      await Promise.all(rootCandidates.map((root) => this.resolveAuthorizedReviewRoot(root)))
    ).filter((root): root is AuthorizedReviewRoot => Boolean(root));
    if (roots.length === 0) {
      throw new Error('Review project/worktree root is unavailable');
    }

    let reviewedFiles: Map<string, FileChangeSummary> | null = null;
    let resolutionMemberName = scope.memberName ?? '';
    if (scope.taskId) {
      const changeSet = await this.dependencies.changes.getTaskChanges(
        scope.teamName,
        scope.taskId
      );
      reviewedFiles = this.collectAuthoritativeReviewedFiles(changeSet.files);
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
      const changeSet = await this.dependencies.changes.getAgentChanges(
        scope.teamName,
        scope.memberName
      );
      reviewedFiles = this.collectAuthoritativeReviewedFiles(changeSet.files);
    }

    return { scope, authorization: { roots, reviewedFiles, resolutionMemberName } };
  }

  async validateAuthorizedReviewFilePath(
    authorization: ReviewPathAuthorization,
    filePathValue: unknown,
    options: { requireReviewedFile: boolean; rejectHardlinks?: boolean }
  ): Promise<string> {
    assertNonEmptyString(filePathValue, 'filePath');
    if (!this.dependencies.paths.isAbsolute(filePathValue)) {
      throw new Error('Review file path must be absolute');
    }
    const normalizedPath = this.dependencies.paths.normalize(filePathValue);
    if (this.dependencies.paths.isSensitive(normalizedPath)) {
      throw new Error('Access to sensitive files is not allowed');
    }
    if (
      options.requireReviewedFile &&
      !authorization.reviewedFiles?.has(this.normalizeReviewPathForIdentity(normalizedPath))
    ) {
      throw new Error('File is not part of the reviewed scope');
    }

    let targetRealPath: string;
    let targetStat: Awaited<
      ReturnType<ReviewScopeAuthorizationDependencies['files']['lstat']>
    > | null = null;
    let resolvedStat: Awaited<
      ReturnType<ReviewScopeAuthorizationDependencies['files']['stat']>
    > | null = null;
    try {
      targetStat = await this.dependencies.files.lstat(normalizedPath);
      targetRealPath = this.dependencies.paths.normalize(
        await this.dependencies.files.realpath(normalizedPath)
      );
      resolvedStat =
        targetStat.kind === 'symbolic-link'
          ? await this.dependencies.files.stat(targetRealPath)
          : targetStat;
      if (resolvedStat.kind !== 'file') {
        throw new Error('Review target must be a regular file');
      }
    } catch (error) {
      const code = this.getErrorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      targetRealPath = await this.resolveNearestExistingRealPath(
        this.dependencies.paths.dirname(normalizedPath)
      );
    }
    if (this.dependencies.paths.isSensitive(targetRealPath)) {
      throw new Error('Access to sensitive files is not allowed');
    }

    if (!this.isAuthorizedPath(authorization, normalizedPath, targetRealPath)) {
      throw new Error('Review file path is outside the authoritative project/worktree');
    }
    if (options.rejectHardlinks && targetStat && resolvedStat) {
      if (targetStat.kind !== 'symbolic-link' && resolvedStat.linkCount > 1) {
        await this.dependencies.files.cleanupOwnedTemporaryLinks(normalizedPath);
        targetStat = await this.dependencies.files.lstat(normalizedPath);
        targetRealPath = this.dependencies.paths.normalize(
          await this.dependencies.files.realpath(normalizedPath)
        );
        resolvedStat =
          targetStat.kind === 'symbolic-link'
            ? await this.dependencies.files.stat(targetRealPath)
            : targetStat;
        const stillAllowed =
          !this.dependencies.paths.isSensitive(targetRealPath) &&
          this.isAuthorizedPath(authorization, normalizedPath, targetRealPath);
        if (!stillAllowed || resolvedStat.kind !== 'file') {
          throw new Error('Review file path changed during authorization');
        }
      }
      const ownedReviewTransactionLink =
        targetStat.kind !== 'symbolic-link' &&
        resolvedStat.linkCount > 1 &&
        (await this.dependencies.files.isOwnedTransactionHardlink(normalizedPath));
      if (
        targetStat.kind === 'symbolic-link' ||
        (resolvedStat.linkCount > 1 && !ownedReviewTransactionLink)
      ) {
        throw new Error('Review mutation refuses symbolic or multiply-linked files');
      }
    }
    return normalizedPath;
  }

  getAuthoritativeReviewedFile(
    authorization: ReviewPathAuthorization,
    filePath: string
  ): FileChangeSummary {
    const file = authorization.reviewedFiles?.get(this.normalizeReviewPathForIdentity(filePath));
    if (!file) {
      throw new Error('File is not part of the reviewed scope');
    }
    return file;
  }

  async resolveAuthoritativeFileContent(
    scope: ReviewFileScope,
    authorization: ReviewPathAuthorization,
    filePath: string
  ): Promise<FileChangeWithContent> {
    const authoritativeFile = this.getAuthoritativeReviewedFile(authorization, filePath);
    assertSnippetShapes(authoritativeFile.snippets);
    await this.validateSnippetPaths(authorization, authoritativeFile.snippets, {
      requireReviewedFile: true,
    });
    const resolved = await this.dependencies.content.getFileContent(
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

  assertExpectedAuthoritativeRename(
    content: FileChangeWithContent,
    expectation: ReviewRenameRecoveryExpectation
  ): void {
    assertExpectedAuthoritativeRename(content, expectation);
  }

  invalidateAuthoritativeReviewContent(content: FileChangeWithContent): void {
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
      this.dependencies.content.invalidateFile(filePath);
    }
  }

  async validateSnippetPaths(
    authorization: ReviewPathAuthorization,
    snippets: SnippetDiff[],
    options: { requireReviewedFile?: boolean; rejectHardlinks?: boolean } = {}
  ): Promise<void> {
    const requireReviewedFile = options.requireReviewedFile === true;
    await Promise.all(
      snippets.map((snippet) =>
        this.validateAuthorizedReviewFilePath(authorization, snippet.filePath, {
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
      if (relationPaths.every((relationPath) => this.dependencies.paths.isAbsolute(relationPath))) {
        for (const relationPath of relationPaths) {
          await this.validateAuthorizedReviewFilePath(authorization, relationPath, {
            requireReviewedFile,
            rejectHardlinks: options.rejectHardlinks === true,
          });
        }
        continue;
      }
      if (relationPaths.some((relationPath) => this.dependencies.paths.isAbsolute(relationPath))) {
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
          const anchorPath = this.dependencies.paths.normalize(`${prefix}${slashAnchor}`);
          const targetPath = this.dependencies.paths.normalize(
            `${prefix}${targetRelationPath.replace(/\\/g, '/')}`
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
        await this.validateAuthorizedReviewFilePath(authorization, relationPath, {
          requireReviewedFile,
          rejectHardlinks: options.rejectHardlinks === true,
        });
      }
    }
  }

  private collectAuthoritativeReviewedFiles(
    files: FileChangeSummary[]
  ): Map<string, FileChangeSummary> {
    const reviewedFiles = new Map<string, FileChangeSummary>();
    const add = (filePath: string | null, owner: FileChangeSummary): void => {
      if (filePath && this.dependencies.paths.isAbsolute(filePath)) {
        reviewedFiles.set(this.normalizeReviewPathForIdentity(filePath), owner);
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

  private async resolveAuthorizedReviewRoot(
    rootPath: string
  ): Promise<AuthorizedReviewRoot | null> {
    if (!this.dependencies.paths.isAbsolute(rootPath)) {
      return null;
    }
    try {
      const [rootStat, realPath] = await Promise.all([
        this.dependencies.files.stat(rootPath),
        this.dependencies.files.realpath(rootPath),
      ]);
      if (rootStat.kind !== 'directory') {
        return null;
      }
      return {
        lexicalPath: this.dependencies.paths.normalize(rootPath),
        realPath: this.dependencies.paths.normalize(realPath),
      };
    } catch {
      return null;
    }
  }

  private async resolveNearestExistingRealPath(filePath: string): Promise<string> {
    let current = filePath;
    for (;;) {
      try {
        return this.dependencies.paths.normalize(await this.dependencies.files.realpath(current));
      } catch (error) {
        const code = this.getErrorCode(error);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw error;
        }
        const parent = this.dependencies.paths.dirname(current);
        if (parent === current) {
          throw new Error('No existing ancestor for review file path');
        }
        current = parent;
      }
    }
  }

  private isAuthorizedPath(
    authorization: ReviewPathAuthorization,
    normalizedPath: string,
    targetRealPath: string
  ): boolean {
    return authorization.roots.some(
      (root) =>
        (this.dependencies.paths.isWithinRoot(normalizedPath, root.lexicalPath) ||
          this.dependencies.paths.isWithinRoot(normalizedPath, root.realPath)) &&
        this.dependencies.paths.isWithinRoot(targetRealPath, root.realPath)
    );
  }

  private getErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined;
  }
}
