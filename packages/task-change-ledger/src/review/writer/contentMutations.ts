import { getDisplayedReviewedFile } from './authoritativeReviewFiles.js';
import type { ReviewWriterContext } from './ports.js';
import type { FileChangeWithContent } from '../../contracts.js';
import {
  assertOptionalString,
  assertSnippetShapes,
  normalizeReviewIdentity,
  validateSnippetPaths,
  parseReviewRenameRecoveryExpectation,
} from './validation.js';
import {
  resolveReviewPathAuthorization,
  validateAuthorizedReviewFilePath,
  resolveAuthoritativeFileContent,
  assertExpectedAuthoritativeRename,
  invalidateAuthoritativeReviewContent,
} from './scopeAuthorization.js';
import { registerDisplayedReviewSnapshot } from './displayedSnapshots.js';
import { renameStandalone } from './standaloneMutations.js';

export async function handleGetFileContent(
  env: Pick<
    ReviewWriterContext,
    'assertActive' | 'authorization' | 'changes' | 'content' | 'snapshots'
  >,
  teamNameValue: unknown,
  memberNameValue: unknown,
  filePathValue: unknown,
  snippetsValue: unknown = []
): Promise<FileChangeWithContent> {
  return (async () => {
    assertOptionalString(memberNameValue, 'memberName');
    assertSnippetShapes(snippetsValue);
    const { scope, authorization } = await resolveReviewPathAuthorization(env, {
      teamName: teamNameValue,
      memberName: normalizeReviewIdentity(memberNameValue),
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: false,
    });
    await validateSnippetPaths(authorization, snippetsValue);
    const content = await (env.assertActive(),
    env.content.getFileContent(scope.teamName, scope.memberName ?? '', filePath, snippetsValue));
    const file = getDisplayedReviewedFile(authorization.reviewedFiles, filePath, snippetsValue);
    return registerDisplayedReviewSnapshot(env, scope.teamName, filePath, snippetsValue, content, file?.changeKey ?? file?.filePath ?? filePath);
  })();
}

// --- Editable diff Handlers ---
export async function handleSaveEditedFile(
  env: Pick<
    ReviewWriterContext,
    'applier' | 'assertActive' | 'authorization' | 'changes' | 'content'
  >,
  scopeValue: unknown,
  filePathValue: unknown,
  content: unknown,
  expectedCurrentContent: string | null | undefined
): Promise<{
  success: boolean;
}> {
  if (
    typeof filePathValue !== 'string' ||
    typeof content !== 'string' ||
    (expectedCurrentContent !== null && typeof expectedCurrentContent !== 'string')
  ) {
    throw new Error('Invalid parameters');
  }
  return (async () => {
    const { authorization } = await resolveReviewPathAuthorization(env, scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const result = await (env.assertActive(),
    env.applier.saveEditedFile(filePath, content, expectedCurrentContent));
    // This public manual save has no parent WAL; durable WAL steps finalize through directDisk.
    await (env.assertActive(),
    env.applier.finalizeEditedFileTransaction?.(filePath, expectedCurrentContent, content));
    // Invalidate cached content so next fetch reads the saved version from disk
    env.assertActive();
    env.content.invalidateFile(filePath);
    return result;
  })();
}

export async function handleDeleteEditedFile(
  env: Pick<
    ReviewWriterContext,
    'applier' | 'assertActive' | 'authorization' | 'changes' | 'content'
  >,
  scopeValue: unknown,
  filePathValue: unknown,
  expectedCurrentContent: unknown
): Promise<{
  success: boolean;
}> {
  if (typeof expectedCurrentContent !== 'string') {
    throw new Error('Invalid parameters');
  }
  return (async () => {
    const { authorization } = await resolveReviewPathAuthorization(env, scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const result = await (env.assertActive(),
    env.applier.deleteEditedFile(filePath, expectedCurrentContent));
    // Direct manual deletes acknowledge their own publication; parent WAL steps finalize separately.
    await (env.assertActive(),
    env.applier.finalizeEditedFileTransaction?.(filePath, expectedCurrentContent, null));
    env.assertActive();
    env.content.invalidateFile(filePath);
    return result;
  })();
}

export async function handleRestoreRejectedRename(
  env: Pick<
    ReviewWriterContext,
    'applier' | 'assertActive' | 'authorization' | 'changes' | 'content'
  >,
  scopeValue: unknown,
  filePathValue: unknown,
  expectationValue: unknown
): Promise<{
  success: boolean;
}> {
  return (async () => {
    const expectation = parseReviewRenameRecoveryExpectation(expectationValue);
    const { scope, authorization } = await resolveReviewPathAuthorization(env, scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const authoritativeContent = await resolveAuthoritativeFileContent(
      env,
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
      return await (env.assertActive(),
      renameStandalone(env, {
        method: 'restoreRejectedRename',
        args: [
          filePath,
          authoritativeContent.originalFullContent,
          authoritativeContent.modifiedFullContent,
          authoritativeContent.snippets,
        ],
      }));
    } finally {
      invalidateAuthoritativeReviewContent(env, authoritativeContent);
    }
  })();
}

export async function handleReapplyRejectedRename(
  env: Pick<
    ReviewWriterContext,
    'applier' | 'assertActive' | 'authorization' | 'changes' | 'content'
  >,
  scopeValue: unknown,
  filePathValue: unknown,
  expectationValue: unknown
): Promise<{
  success: boolean;
}> {
  return (async () => {
    const expectation = parseReviewRenameRecoveryExpectation(expectationValue);
    const { scope, authorization } = await resolveReviewPathAuthorization(env, scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    const authoritativeContent = await resolveAuthoritativeFileContent(
      env,
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
      return await (env.assertActive(),
      renameStandalone(env, {
        method: 'reapplyRejectedRename',
        args: [filePath, authoritativeContent.originalFullContent, authoritativeContent.snippets],
      }));
    } finally {
      invalidateAuthoritativeReviewContent(env, authoritativeContent);
    }
  })();
}
