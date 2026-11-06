import type { ReviewWriterContext } from './ports.js';
import type { ConflictCheckResult, RejectResult, SnippetDiff } from '../../contracts.js';
import {
  resolveReviewPathAuthorization,
  validateAuthorizedReviewFilePath,
  resolveAuthoritativeFileContent,
} from './scopeAuthorization.js';
import { assertHunkIndices } from './validation.js';
import { rejectStandalone } from './standaloneMutations.js';

// --- Phase 2 Handlers ---
export async function handleCheckConflict(
  env: Pick<ReviewWriterContext, 'applier' | 'assertActive' | 'authorization' | 'changes'>,
  scopeValue: unknown,
  filePathValue: unknown,
  expectedModified: unknown
): Promise<ConflictCheckResult> {
  return (async () => {
    if (typeof expectedModified !== 'string') {
      throw new Error('Invalid expectedModified');
    }
    const { authorization } = await resolveReviewPathAuthorization(env, scopeValue, {
      requireIdentity: true,
    });
    const filePath = await validateAuthorizedReviewFilePath(authorization, filePathValue, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
    return (env.assertActive(), env.applier.checkConflict(filePath, expectedModified));
  })();
}

export async function handleRejectHunks(
  env: Pick<
    ReviewWriterContext,
    'applier' | 'assertActive' | 'authorization' | 'changes' | 'content'
  >,
  scopeValue: unknown,
  filePathValue: unknown,
  hunkIndices: unknown
): Promise<RejectResult> {
  return (async () => {
    assertHunkIndices(hunkIndices);
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
    if (
      authoritativeContent.originalFullContent === null ||
      authoritativeContent.modifiedFullContent === null
    ) {
      throw new Error('Authoritative review contents are unavailable');
    }
    return (
      env.assertActive(),
      rejectStandalone(env, {
        method: 'rejectHunks',
        args: [
          scope.teamName,
          filePath,
          authoritativeContent.originalFullContent,
          authoritativeContent.modifiedFullContent,
          hunkIndices,
          authoritativeContent.snippets,
        ],
      })
    );
  })();
}

export async function handleRejectFile(
  env: Pick<
    ReviewWriterContext,
    'applier' | 'assertActive' | 'authorization' | 'changes' | 'content'
  >,
  scopeValue: unknown,
  filePathValue: unknown
): Promise<RejectResult> {
  return (async () => {
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
    if (
      authoritativeContent.originalFullContent === null ||
      authoritativeContent.modifiedFullContent === null
    ) {
      throw new Error('Authoritative review contents are unavailable');
    }
    return (
      env.assertActive(),
      rejectStandalone(env, {
        method: 'rejectFile',
        args: [
          scope.teamName,
          filePath,
          authoritativeContent.originalFullContent,
          authoritativeContent.modifiedFullContent,
        ],
      })
    );
  })();
}

export async function handlePreviewReject(
  env: Pick<ReviewWriterContext, 'applier' | 'assertActive'>,
  filePath: string,
  original: string,
  modified: string,
  hunkIndices: number[],
  snippets: SnippetDiff[]
): Promise<{
  preview: string;
  hasConflicts: boolean;
}> {
  return (() => (
    env.assertActive(),
    env.applier.previewReject(filePath, original, modified, hunkIndices, snippets)
  ))();
}
