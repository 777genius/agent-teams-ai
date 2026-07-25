import type {
  FileChangeWithContent,
  ReviewFileScope,
  ReviewRenameRecoveryExpectation,
  SnippetDiff,
} from '@shared/types/review';

export const MAX_REVIEW_SNIPPETS_PER_FILE = 10_000;
export const MAX_REVIEW_HUNK_DECISIONS_PER_FILE = 100_000;

export interface ReviewIdentityValidationResult {
  valid: boolean;
  value?: string;
  error?: string;
}

export interface ReviewIdentityValidators {
  validateTeamName(value: unknown): ReviewIdentityValidationResult;
  validateTaskId(value: unknown): ReviewIdentityValidationResult;
}

export interface ReviewRootConfig {
  projectPath?: string;
  members?: readonly { cwd?: string }[];
}

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

export function parseReviewFileScope(
  value: unknown,
  validators: ReviewIdentityValidators
): ReviewFileScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid review scope');
  }
  const raw = value as Record<string, unknown>;
  const team = validators.validateTeamName(raw.teamName);
  if (!team.valid || !team.value) {
    throw new Error(team.error ?? 'Invalid teamName');
  }
  assertOptionalString(raw.memberName, 'memberName');
  assertOptionalString(raw.taskId, 'taskId');
  const memberName = normalizeReviewIdentity(raw.memberName);
  const taskId = normalizeReviewIdentity(raw.taskId);
  if (taskId) {
    const task = validators.validateTaskId(taskId);
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

export function collectReviewRootCandidates(config: ReviewRootConfig): string[] {
  const roots: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      roots.push(value.trim());
    }
  };
  add(config.projectPath);
  const members = Array.isArray(config.members)
    ? (config.members as readonly { cwd?: string }[])
    : [];
  for (const member of members) {
    add(member.cwd);
  }
  return roots;
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
