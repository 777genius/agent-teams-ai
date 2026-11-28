import type {
  ReviewFileScope,
  ReviewRenameRecoveryExpectation,
  SnippetDiff,
  FileReviewDecision,
  ReviewDecisionPersistenceScope,
} from '../../contracts.js';
import { validateTaskId } from './reviewGuards.js';
import { validateTeamName } from './teamIdentifierValidation.js';
import { MAX_REVIEW_HUNK_DECISIONS_PER_FILE, MAX_REVIEW_SNIPPETS_PER_FILE } from './limits.js';
import type { ReviewPathAuthorization } from './displayedSnapshots.js';
import { validateAuthorizedReviewFilePath } from './scopeAuthorization.js';

import * as path from 'path';

export function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${field}: non-empty string required`);
  }
}

export function assertOptionalString(
  value: unknown,
  field: string
): asserts value is string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`Invalid ${field}: string required`);
  }
}

export function normalizeReviewIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function parseReviewFileScope(value: unknown): ReviewFileScope {
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

export function parseReviewRenameRecoveryExpectation(
  value: unknown
): ReviewRenameRecoveryExpectation {
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

export function assertHunkIndices(value: unknown): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_REVIEW_HUNK_DECISIONS_PER_FILE ||
    value.some((index) => !Number.isSafeInteger(index) || index < 0)
  ) {
    throw new Error('Invalid hunkIndices');
  }
}

export function assertSnippetShapes(value: unknown): asserts value is SnippetDiff[] {
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

export async function validateSnippetPaths(
  authorization: ReviewPathAuthorization,
  snippets: SnippetDiff[],
  options: {
    requireReviewedFile?: boolean;
    rejectHardlinks?: boolean;
  } = {}
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

export function assertReviewDecisionShape(value: unknown): asserts value is FileReviewDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid review decision');
  }
  const raw = value as Record<string, unknown>;
  assertNonEmptyString(raw.filePath, 'decision.filePath');
  if (
    raw.reviewKey !== undefined &&
    (typeof raw.reviewKey !== 'string' ||
      raw.reviewKey.length === 0 ||
      raw.reviewKey.length > 32768 ||
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

export function parseDecisionPersistenceScope(
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
