import { atomicWriteAsync, unlinkPathDurably } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import {
  assertConstrainedPersistenceDirectory,
  ensureConstrainedPersistenceDirectory,
  quarantineConstrainedPersistenceFile,
} from '@main/utils/safePersistenceDirectory';
import { createLogger } from '@shared/utils/logger';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type {
  ReviewDraftHistoryConflictCandidate,
  ReviewDraftHistoryConflictCandidateSummary,
  ReviewDraftHistoryEntry,
  ReviewDraftHistoryJsonValue,
  ReviewDraftHistorySnapshot,
  ReviewSerializedEditorState,
} from '@features/change-review-history/contracts';
import type { ReviewConflictResolution } from '@shared/types';

const logger = createLogger('ReviewDraftHistoryStore');
const STORE_VERSION = 1;
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SCOPE_KEY_PATTERN = /^(?:task|agent)-[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
// Keep parity with ReviewDecisionStore: legacy content-derived scope tokens may include
// full snippet text when no compact provenance fingerprint is available.
const MAX_SCOPE_TOKEN_LENGTH = 32 * 1024 * 1024;
const MAX_FILE_PATH_LENGTH = 32 * 1024;
const MAX_HISTORY_FILE_BYTES = 128 * 1024 * 1024;
const MAX_HISTORY_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 512;
const MAX_GENERATION_LENGTH = 128;
const MAX_EXACT_SCOPES_PER_LOGICAL_SCOPE = 16;
const MAX_CONFLICT_CANDIDATES_PER_SCOPE = 32;
const MAX_CONFLICT_CANDIDATES_PER_LOGICAL_SCOPE = 64;
const MAX_JSON_DEPTH = 100;
const MAX_JSON_NODES = 1_000_000;

interface StoredReviewDraftHistory {
  version: 1;
  scopeKey: string;
  scopeTokenHash: string;
  entries: Record<string, ReviewDraftHistoryEntry>;
  updatedAt: string;
}

interface StoredReviewDraftHistoryConflictCandidateV1 extends Omit<
  ReviewDraftHistoryConflictCandidate,
  'origin'
> {
  version: 1;
  scopeKey: string;
  scopeTokenHash: string;
  entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>;
}

interface StoredReviewDraftHistoryConflictCandidateV2 extends Omit<
  ReviewDraftHistoryConflictCandidate,
  'origin'
> {
  version: 2;
  scopeKey: string;
  scopeTokenHash: string;
  entry: null;
}

export interface SaveReviewDraftHistoryEntryInput {
  filePath: string;
  codec: 'codemirror-history-v1';
  /** Last per-file revision durably observed by this writer. */
  expectedRevision: number;
  /** Exact generation paired with expectedRevision; null only when no entry was observed. */
  expectedGeneration: string | null;
  revision: number;
  diskBaseline: string | null;
  editorState: ReviewSerializedEditorState;
}

class InvalidReviewDraftHistoryError extends Error {}

function shouldQuarantineDraftConflictCandidate(error: unknown): boolean {
  if (error instanceof InvalidReviewDraftHistoryError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith('Unsafe review draft conflict candidate') ||
    error.message === 'Unsafe or oversized review draft conflict candidate' ||
    error.message === 'Review draft conflict candidate changed while being read'
  );
}

function getScopeTokenHash(scopeToken: string): string {
  return createHash('sha256').update(scopeToken).digest('hex');
}

function isJsonValue(value: unknown): value is ReviewDraftHistoryJsonValue {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes++;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;
    const item = current.value;
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!item || typeof item !== 'object') {
      return false;
    }
    const prototype = Reflect.getPrototypeOf(item);
    // CodeMirror's own toJSON() intentionally emits null-prototype dictionaries.
    // Accept only those and ordinary JSON records, never class instances.
    if (prototype !== null && prototype !== Object.prototype) {
      return false;
    }
    for (const [key, child] of Object.entries(item)) {
      if (key.length > MAX_FILE_PATH_LENGTH) return false;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function isSerializedEditorState(value: unknown): value is ReviewSerializedEditorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const history = record.history;
  return (
    typeof record.doc === 'string' &&
    !!history &&
    typeof history === 'object' &&
    !Array.isArray(history) &&
    Array.isArray((history as Record<string, unknown>).done) &&
    Array.isArray((history as Record<string, unknown>).undone) &&
    isJsonValue(value)
  );
}

function entriesEqual(
  existing: ReviewDraftHistoryEntry,
  incoming: SaveReviewDraftHistoryEntryInput
): boolean {
  return (
    existing.filePath === incoming.filePath &&
    existing.codec === incoming.codec &&
    existing.revision === incoming.revision &&
    existing.diskBaseline === incoming.diskBaseline &&
    JSON.stringify(existing.editorState) === JSON.stringify(incoming.editorState)
  );
}

function conflictEntriesEqual(
  left: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
  right: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>
): boolean {
  return (
    left.filePath === right.filePath &&
    left.codec === right.codec &&
    left.revision === right.revision &&
    left.diskBaseline === right.diskBaseline &&
    JSON.stringify(left.editorState) === JSON.stringify(right.editorState)
  );
}

function isValidGeneration(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_GENERATION_LENGTH &&
    !value.includes('\0')
  );
}

function getLegacyGeneration(entry: Omit<ReviewDraftHistoryEntry, 'generation'>): string {
  return `legacy-${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`;
}

export class ReviewDraftHistoryStore {
  private assertSafeScope(teamName: string, scopeKey: string, scopeToken: string): void {
    if (typeof teamName !== 'string' || !TEAM_NAME_PATTERN.test(teamName)) {
      throw new Error('Invalid review draft history team name');
    }
    if (typeof scopeKey !== 'string' || !SCOPE_KEY_PATTERN.test(scopeKey)) {
      throw new Error('Invalid review draft history scope key');
    }
    if (
      typeof scopeToken !== 'string' ||
      scopeToken.length === 0 ||
      scopeToken.length > MAX_SCOPE_TOKEN_LENGTH ||
      scopeToken.includes('\0')
    ) {
      throw new Error('Invalid review draft history scope token');
    }
  }

  private assertEntry(input: SaveReviewDraftHistoryEntryInput): void {
    if (
      typeof input.filePath !== 'string' ||
      input.filePath.length === 0 ||
      input.filePath.length > MAX_FILE_PATH_LENGTH ||
      input.filePath.includes('\0') ||
      input.codec !== 'codemirror-history-v1' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      (input.expectedRevision === 0
        ? input.expectedGeneration !== null
        : !isValidGeneration(input.expectedGeneration)) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision <= input.expectedRevision ||
      (input.diskBaseline !== null && typeof input.diskBaseline !== 'string') ||
      !isSerializedEditorState(input.editorState)
    ) {
      throw new Error('Invalid review draft history entry');
    }
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_HISTORY_ENTRY_BYTES) {
      throw new Error('Review draft history entry exceeds the durable storage limit');
    }
  }

  private getScopeDir(teamName: string, scopeKey: string): string {
    return path.join(
      getTeamsBasePath(),
      teamName,
      'review-decisions',
      'draft-history',
      'v1',
      encodeURIComponent(scopeKey)
    );
  }

  private getFilePath(teamName: string, scopeKey: string, scopeToken: string): string {
    return path.join(this.getScopeDir(teamName, scopeKey), `${getScopeTokenHash(scopeToken)}.json`);
  }

  private getConflictCandidateDir(teamName: string, scopeKey: string, scopeToken: string): string {
    return this.getConflictCandidateDirByScopeHash(
      teamName,
      scopeKey,
      getScopeTokenHash(scopeToken)
    );
  }

  private getConflictScopeDir(teamName: string, scopeKey: string): string {
    return path.join(
      getTeamsBasePath(),
      teamName,
      'review-decisions',
      'draft-history',
      'conflicts',
      'v1',
      encodeURIComponent(scopeKey)
    );
  }

  private getConflictCandidateDirByScopeHash(
    teamName: string,
    scopeKey: string,
    scopeHash: string
  ): string {
    if (!/^[a-f0-9]{64}$/.test(scopeHash)) {
      throw new Error('Invalid review draft history conflict scope hash');
    }
    return path.join(this.getConflictScopeDir(teamName, scopeKey), scopeHash);
  }

  private async inspectConflictScopes(
    teamName: string,
    scopeKey: string
  ): Promise<{ scopeHashes: Set<string>; candidatePaths: Set<string> }> {
    const rootPath = this.getConflictScopeDir(teamName, scopeKey);
    if (!(await assertConstrainedPersistenceDirectory(getTeamsBasePath(), rootPath))) {
      return { scopeHashes: new Set(), candidatePaths: new Set() };
    }
    const scopeEntries = await fs.promises.readdir(rootPath);
    const scopeHashes = new Set<string>();
    const candidatePaths = new Set<string>();
    for (const scopeHash of scopeEntries.filter((entry) => /^[a-f0-9]{64}$/.test(entry))) {
      const scopeDir = this.getConflictCandidateDirByScopeHash(teamName, scopeKey, scopeHash);
      if (!(await assertConstrainedPersistenceDirectory(getTeamsBasePath(), scopeDir))) continue;
      const entries = await fs.promises.readdir(scopeDir);
      for (const entry of entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
        scopeHashes.add(scopeHash);
        candidatePaths.add(path.join(scopeDir, entry));
      }
    }
    return { scopeHashes, candidatePaths };
  }

  private getConflictCandidatePath(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): string {
    if (!/^[a-f0-9]{64}$/.test(candidateId)) {
      throw new Error('Invalid review draft history conflict candidate id');
    }
    return path.join(
      this.getConflictCandidateDir(teamName, scopeKey, scopeToken),
      `${candidateId}.json`
    );
  }

  private async ensureConflictCandidateDir(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<string> {
    const dirPath = this.getConflictCandidateDir(teamName, scopeKey, scopeToken);
    await ensureConstrainedPersistenceDirectory(getTeamsBasePath(), dirPath);
    return dirPath;
  }

  private parseStoredData(
    value: unknown,
    scopeKey: string,
    scopeToken: string
  ): StoredReviewDraftHistory {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidReviewDraftHistoryError('Invalid review draft history payload');
    }
    const data = value as Partial<StoredReviewDraftHistory>;
    if (
      data.version !== STORE_VERSION ||
      data.scopeKey !== scopeKey ||
      data.scopeTokenHash !== getScopeTokenHash(scopeToken) ||
      typeof data.updatedAt !== 'string' ||
      !data.entries ||
      typeof data.entries !== 'object' ||
      Array.isArray(data.entries)
    ) {
      throw new InvalidReviewDraftHistoryError('Mismatched review draft history payload');
    }
    const entries = Object.entries(data.entries);
    if (entries.length > MAX_HISTORY_ENTRIES) {
      throw new InvalidReviewDraftHistoryError('Too many review draft history entries');
    }
    for (const [filePath, entry] of entries) {
      const candidate = entry as Partial<ReviewDraftHistoryEntry>;
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        entry.filePath !== filePath ||
        entry.codec !== 'codemirror-history-v1' ||
        filePath.length === 0 ||
        filePath.length > MAX_FILE_PATH_LENGTH ||
        filePath.includes('\0') ||
        !Number.isSafeInteger(entry.revision) ||
        entry.revision < 1 ||
        (entry.diskBaseline !== null && typeof entry.diskBaseline !== 'string') ||
        typeof entry.updatedAt !== 'string' ||
        (candidate.generation !== undefined && !isValidGeneration(candidate.generation)) ||
        !isSerializedEditorState(entry.editorState) ||
        Buffer.byteLength(JSON.stringify(entry), 'utf8') > MAX_HISTORY_ENTRY_BYTES
      ) {
        throw new InvalidReviewDraftHistoryError('Invalid review draft history entry');
      }
      if (candidate.generation === undefined) {
        candidate.generation = getLegacyGeneration(
          entry as Omit<ReviewDraftHistoryEntry, 'generation'>
        );
      }
    }
    return data as StoredReviewDraftHistory;
  }

  private async readStored(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<StoredReviewDraftHistory | null> {
    const filePath = this.getFilePath(teamName, scopeKey, scopeToken);
    if (
      !(await assertConstrainedPersistenceDirectory(getTeamsBasePath(), path.dirname(filePath)))
    ) {
      return null;
    }
    let handle: fs.promises.FileHandle | null = null;
    try {
      const pathStats = await fs.promises.lstat(filePath);
      if (pathStats.isSymbolicLink()) {
        throw new Error('Unsafe review draft history symlink');
      }
      handle = await fs.promises.open(filePath, 'r');
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.size > MAX_HISTORY_FILE_BYTES ||
        stats.dev !== pathStats.dev ||
        stats.ino !== pathStats.ino
      ) {
        throw new Error('Unsafe or oversized review draft history file');
      }
      const raw = await handle.readFile({ encoding: 'utf8' });
      const latestPathStats = await fs.promises.lstat(filePath);
      if (
        latestPathStats.isSymbolicLink() ||
        latestPathStats.dev !== stats.dev ||
        latestPathStats.ino !== stats.ino
      ) {
        throw new Error('Review draft history changed while being read');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new InvalidReviewDraftHistoryError('Corrupted review draft history file', {
          cause: error,
        });
      }
      return this.parseStoredData(parsed, scopeKey, scopeToken);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      logger.error(`Failed to read review draft history at ${filePath}: ${String(error)}`);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async writeStored(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    entries: Record<string, ReviewDraftHistoryEntry>
  ): Promise<void> {
    const payload: StoredReviewDraftHistory = {
      version: STORE_VERSION,
      scopeKey,
      scopeTokenHash: getScopeTokenHash(scopeToken),
      entries,
      updatedAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_HISTORY_FILE_BYTES) {
      throw new Error('Review draft history exceeds the durable storage limit');
    }
    const filePath = this.getFilePath(teamName, scopeKey, scopeToken);
    await ensureConstrainedPersistenceDirectory(getTeamsBasePath(), path.dirname(filePath));
    await atomicWriteAsync(filePath, serialized, {
      mode: 0o600,
      durability: 'strict',
      syncDirectory: true,
    });
    await this.pruneScopeDir(teamName, scopeKey, this.getFilePath(teamName, scopeKey, scopeToken));
  }

  private async pruneScopeDir(
    teamName: string,
    scopeKey: string,
    protectedPath: string
  ): Promise<void> {
    const scopeDir = this.getScopeDir(teamName, scopeKey);
    await ensureConstrainedPersistenceDirectory(getTeamsBasePath(), scopeDir);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(scopeDir);
    } catch {
      return;
    }
    const candidates = await Promise.all(
      entries
        .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
        .map(async (entry) => {
          const filePath = path.join(scopeDir, entry);
          try {
            const stats = await fs.promises.lstat(filePath);
            return stats.isFile() && !stats.isSymbolicLink()
              ? { filePath, mtimeMs: stats.mtimeMs }
              : null;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          }
        })
    );
    const conflictScopes = await this.inspectConflictScopes(teamName, scopeKey);
    const protectedPaths = new Set([
      protectedPath,
      ...[...conflictScopes.scopeHashes].map((scopeHash) =>
        path.join(scopeDir, `${scopeHash}.json`)
      ),
    ]);
    const existing = candidates.filter(
      (entry): entry is { filePath: string; mtimeMs: number } => entry !== null
    );
    const protectedExistingCount = existing.filter((entry) =>
      protectedPaths.has(entry.filePath)
    ).length;
    const unprotectedRetention = Math.max(
      0,
      MAX_EXACT_SCOPES_PER_LOGICAL_SCOPE - protectedExistingCount
    );
    const stale = existing
      .filter((entry) => !protectedPaths.has(entry.filePath))
      .sort((left, right) => {
        return right.mtimeMs - left.mtimeMs;
      })
      .slice(unprotectedRetention);
    await Promise.all(
      stale.map((entry) => unlinkPathDurably(entry.filePath).catch(() => undefined))
    );
  }

  private getConflictCandidateIdentityPayload(input: {
    scopeKey: string;
    scopeTokenHash: string;
    expectedRevision: number;
    expectedGeneration: string | null;
    filePath: string;
    entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'> | null;
  }): object {
    if (input.entry === null) {
      return {
        scopeKey: input.scopeKey,
        scopeTokenHash: input.scopeTokenHash,
        expectedRevision: input.expectedRevision,
        expectedGeneration: input.expectedGeneration,
        filePath: input.filePath,
        entry: null,
      };
    }
    return {
      scopeKey: input.scopeKey,
      scopeTokenHash: input.scopeTokenHash,
      expectedRevision: input.expectedRevision,
      expectedGeneration: input.expectedGeneration,
      entry: input.entry,
    };
  }

  private parseConflictCandidate(
    value: unknown,
    scopeKey: string,
    sourceScopeHash: string,
    currentScopeHash: string
  ): ReviewDraftHistoryConflictCandidate {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidReviewDraftHistoryError('Invalid review draft conflict candidate');
    }
    const candidate = value as Partial<
      StoredReviewDraftHistoryConflictCandidateV1 | StoredReviewDraftHistoryConflictCandidateV2
    >;
    if (!/^[a-f0-9]{64}$/.test(sourceScopeHash) || !/^[a-f0-9]{64}$/.test(currentScopeHash)) {
      throw new InvalidReviewDraftHistoryError(
        'Invalid review draft conflict candidate scope hash'
      );
    }
    const scopeTokenHash = sourceScopeHash;
    const isTombstone = candidate.version === 2 && candidate.entry === null;
    if (
      (candidate.version !== 1 && !isTombstone) ||
      candidate.scopeKey !== scopeKey ||
      candidate.scopeTokenHash !== scopeTokenHash ||
      typeof candidate.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(candidate.id) ||
      typeof candidate.capturedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.capturedAt)) ||
      typeof candidate.filePath !== 'string' ||
      candidate.filePath.length === 0 ||
      candidate.filePath.length > MAX_FILE_PATH_LENGTH ||
      candidate.filePath.includes('\0') ||
      typeof candidate.expectedRevision !== 'number' ||
      !Number.isSafeInteger(candidate.expectedRevision) ||
      candidate.expectedRevision < 0 ||
      (candidate.expectedRevision === 0
        ? candidate.expectedGeneration !== null
        : !isValidGeneration(candidate.expectedGeneration)) ||
      typeof candidate.observedCurrentRevision !== 'number' ||
      !Number.isSafeInteger(candidate.observedCurrentRevision) ||
      candidate.observedCurrentRevision < 0 ||
      (candidate.observedCurrentRevision === 0
        ? candidate.observedCurrentGeneration !== null
        : !isValidGeneration(candidate.observedCurrentGeneration)) ||
      (isTombstone
        ? candidate.expectedRevision !== 0 || candidate.expectedGeneration !== null
        : !candidate.entry || typeof candidate.entry !== 'object' || Array.isArray(candidate.entry))
    ) {
      throw new InvalidReviewDraftHistoryError('Invalid review draft conflict candidate');
    }
    const entry = isTombstone ? null : candidate.entry!;
    if (entry) {
      this.assertEntry({
        ...entry,
        expectedRevision: candidate.expectedRevision,
        expectedGeneration: candidate.expectedGeneration as string | null,
      });
      if (candidate.filePath !== entry.filePath) {
        throw new InvalidReviewDraftHistoryError('Mismatched review draft conflict file');
      }
    }
    const identity = this.getConflictCandidateIdentityPayload({
      scopeKey,
      scopeTokenHash,
      expectedRevision: candidate.expectedRevision,
      expectedGeneration: candidate.expectedGeneration as string | null,
      filePath: candidate.filePath,
      entry,
    });
    const expectedId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    if (candidate.id !== expectedId) {
      throw new InvalidReviewDraftHistoryError('Mismatched review draft conflict identity');
    }
    return {
      id: candidate.id,
      capturedAt: candidate.capturedAt,
      origin: sourceScopeHash === currentScopeHash ? 'current-snapshot' : 'prior-snapshot',
      filePath: candidate.filePath,
      expectedRevision: candidate.expectedRevision,
      expectedGeneration: candidate.expectedGeneration as string | null,
      observedCurrentRevision: candidate.observedCurrentRevision,
      observedCurrentGeneration: candidate.observedCurrentGeneration as string | null,
      entry,
    };
  }

  private async loadConflictCandidateFromPath(
    filePath: string,
    scopeKey: string,
    sourceScopeHash: string,
    currentScopeHash: string
  ): Promise<ReviewDraftHistoryConflictCandidate> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      const pathStats = await fs.promises.lstat(filePath);
      if (pathStats.isSymbolicLink()) {
        throw new Error('Unsafe review draft conflict candidate symlink');
      }
      handle = await fs.promises.open(filePath, 'r');
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.size > MAX_HISTORY_ENTRY_BYTES ||
        stats.dev !== pathStats.dev ||
        stats.ino !== pathStats.ino
      ) {
        throw new Error('Unsafe or oversized review draft conflict candidate');
      }
      const raw = await handle.readFile({ encoding: 'utf8' });
      const latestPathStats = await fs.promises.lstat(filePath);
      if (
        latestPathStats.isSymbolicLink() ||
        latestPathStats.dev !== stats.dev ||
        latestPathStats.ino !== stats.ino
      ) {
        throw new Error('Review draft conflict candidate changed while being read');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new InvalidReviewDraftHistoryError('Corrupted review draft conflict candidate', {
          cause: error,
        });
      }
      const candidate = this.parseConflictCandidate(
        parsed,
        scopeKey,
        sourceScopeHash,
        currentScopeHash
      );
      if (path.basename(filePath) !== `${candidate.id}.json`) {
        throw new InvalidReviewDraftHistoryError(
          'Mismatched review draft conflict candidate filename'
        );
      }
      return candidate;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async assertConflictCandidateCapacity(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    protectedPath: string,
    replacementPath?: string
  ): Promise<void> {
    const dirPath = this.getConflictCandidateDir(teamName, scopeKey, scopeToken);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const candidates = await Promise.all(
      entries
        .filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))
        .map(async (entry) => {
          const filePath = path.join(dirPath, entry);
          try {
            const stats = await fs.promises.lstat(filePath);
            return stats.isFile() && !stats.isSymbolicLink() ? filePath : null;
          } catch {
            return null;
          }
        })
    );
    const existing = candidates.filter(
      (entry): entry is string => entry !== null && entry !== replacementPath
    );
    if (!existing.includes(protectedPath) && existing.length >= MAX_CONFLICT_CANDIDATES_PER_SCOPE) {
      throw new Error(
        `Too many unresolved manual-edit recovery copies (${MAX_CONFLICT_CANDIDATES_PER_SCOPE}). Resolve one before saving another branch.`
      );
    }
    const logicalScopeCandidates = (await this.inspectConflictScopes(teamName, scopeKey))
      .candidatePaths;
    const retainedLogicalScopeCandidates = [...logicalScopeCandidates].filter(
      (candidatePath) => candidatePath !== replacementPath
    );
    if (
      !retainedLogicalScopeCandidates.includes(protectedPath) &&
      retainedLogicalScopeCandidates.length >= MAX_CONFLICT_CANDIDATES_PER_LOGICAL_SCOPE
    ) {
      throw new Error(
        `Too many unresolved manual-edit recovery copies for this task or agent (${MAX_CONFLICT_CANDIDATES_PER_LOGICAL_SCOPE}). Resolve one before saving another branch.`
      );
    }
  }

  private async writeConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    input: SaveReviewDraftHistoryEntryInput,
    observedCurrentRevision: number,
    observedCurrentGeneration: string | null,
    replacementPath?: string
  ): Promise<ReviewDraftHistoryConflictCandidate> {
    const { expectedRevision, expectedGeneration, ...entry } = input;
    const scopeTokenHash = getScopeTokenHash(scopeToken);
    const identity = this.getConflictCandidateIdentityPayload({
      scopeKey,
      scopeTokenHash,
      expectedRevision,
      expectedGeneration,
      filePath: entry.filePath,
      entry,
    });
    const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const candidate: StoredReviewDraftHistoryConflictCandidateV1 = {
      version: 1,
      id,
      scopeKey,
      scopeTokenHash,
      capturedAt: new Date().toISOString(),
      filePath: entry.filePath,
      expectedRevision,
      expectedGeneration,
      observedCurrentRevision,
      observedCurrentGeneration,
      entry,
    };
    const serialized = JSON.stringify(candidate);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_HISTORY_ENTRY_BYTES) {
      throw new Error('Review draft recovery candidate exceeds the durable storage limit');
    }
    const filePath = this.getConflictCandidatePath(teamName, scopeKey, scopeToken, id);
    await this.ensureConflictCandidateDir(teamName, scopeKey, scopeToken);
    await this.assertConflictCandidateCapacity(
      teamName,
      scopeKey,
      scopeToken,
      filePath,
      replacementPath
    );
    await atomicWriteAsync(filePath, serialized, {
      mode: 0o600,
      durability: 'strict',
      syncDirectory: true,
    });
    return {
      id,
      capturedAt: candidate.capturedAt,
      origin: 'current-snapshot',
      filePath: entry.filePath,
      expectedRevision,
      expectedGeneration,
      observedCurrentRevision,
      observedCurrentGeneration,
      entry,
    };
  }

  private async writeEmptyConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    filePath: string,
    replacementPath?: string
  ): Promise<ReviewDraftHistoryConflictCandidate> {
    const scopeTokenHash = getScopeTokenHash(scopeToken);
    const identity = this.getConflictCandidateIdentityPayload({
      scopeKey,
      scopeTokenHash,
      expectedRevision: 0,
      expectedGeneration: null,
      filePath,
      entry: null,
    });
    const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const candidate: StoredReviewDraftHistoryConflictCandidateV2 = {
      version: 2,
      id,
      scopeKey,
      scopeTokenHash,
      capturedAt: new Date().toISOString(),
      filePath,
      expectedRevision: 0,
      expectedGeneration: null,
      observedCurrentRevision: 0,
      observedCurrentGeneration: null,
      entry: null,
    };
    const serialized = JSON.stringify(candidate);
    const candidatePath = this.getConflictCandidatePath(teamName, scopeKey, scopeToken, id);
    await this.ensureConflictCandidateDir(teamName, scopeKey, scopeToken);
    await this.assertConflictCandidateCapacity(
      teamName,
      scopeKey,
      scopeToken,
      candidatePath,
      replacementPath
    );
    await atomicWriteAsync(candidatePath, serialized, {
      mode: 0o600,
      durability: 'strict',
      syncDirectory: true,
    });
    return { ...candidate, origin: 'current-snapshot' };
  }

  async load(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistorySnapshot | null> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    const stored = await this.readStored(teamName, scopeKey, scopeToken);
    return stored ? { entries: stored.entries } : null;
  }

  private async mapConflictCandidates<T extends { id: string; capturedAt: string }>(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    mapCandidate: (candidate: ReviewDraftHistoryConflictCandidate) => T
  ): Promise<T[]> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    const currentScopeHash = getScopeTokenHash(scopeToken);
    const conflictScopes = await this.inspectConflictScopes(teamName, scopeKey);
    const stored = await this.readStored(teamName, scopeKey, scopeToken);
    const candidates: T[] = [];
    let quarantinedCount = 0;
    for (const sourceScopeHash of [...conflictScopes.scopeHashes].sort()) {
      const dirPath = this.getConflictCandidateDirByScopeHash(teamName, scopeKey, sourceScopeHash);
      const entries = await fs.promises.readdir(dirPath);
      for (const entry of entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
        const candidatePath = path.join(dirPath, entry);
        try {
          const candidate = await this.loadConflictCandidateFromPath(
            candidatePath,
            scopeKey,
            sourceScopeHash,
            currentScopeHash
          );
          const current = stored?.entries[candidate.filePath];
          candidates.push(
            mapCandidate({
              ...candidate,
              observedCurrentRevision: current?.revision ?? 0,
              observedCurrentGeneration: current?.generation ?? null,
            })
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          if (!shouldQuarantineDraftConflictCandidate(error)) throw error;
          try {
            await quarantineConstrainedPersistenceFile(
              getTeamsBasePath(),
              candidatePath,
              path.join(dirPath, 'quarantine')
            );
          } catch (quarantineError) {
            if ((quarantineError as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw quarantineError;
          }
          quarantinedCount += 1;
          logger.warn(`Quarantined unreadable manual-edit recovery copy: ${String(error)}`);
        }
      }
    }
    if (quarantinedCount > 0) {
      throw new InvalidReviewDraftHistoryError(
        `${quarantinedCount} unreadable manual-edit recovery copy was quarantined; retry recovery check`
      );
    }
    return candidates.sort(
      (left, right) =>
        Date.parse(right.capturedAt) - Date.parse(left.capturedAt) ||
        left.id.localeCompare(right.id)
    );
  }

  async loadConflictCandidates(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistoryConflictCandidate[]> {
    return this.mapConflictCandidates(teamName, scopeKey, scopeToken, (candidate) => candidate);
  }

  async loadConflictCandidateSummaries(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistoryConflictCandidateSummary[]> {
    return this.mapConflictCandidates(teamName, scopeKey, scopeToken, (candidate) => ({
      id: candidate.id,
      capturedAt: candidate.capturedAt,
      origin: candidate.origin,
      recoverability: 'recoverable',
      filePath: candidate.filePath,
      expectedRevision: candidate.expectedRevision,
      expectedGeneration: candidate.expectedGeneration,
      observedCurrentRevision: candidate.observedCurrentRevision,
      observedCurrentGeneration: candidate.observedCurrentGeneration,
      entryRevision: candidate.entry?.revision ?? null,
    }));
  }

  private async locateConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<{ candidatePath: string; candidate: ReviewDraftHistoryConflictCandidate }> {
    if (!/^[a-f0-9]{64}$/.test(candidateId)) {
      throw new Error('Invalid review draft history conflict candidate id');
    }
    const currentScopeHash = getScopeTokenHash(scopeToken);
    const conflictScopes = await this.inspectConflictScopes(teamName, scopeKey);
    let located: {
      candidatePath: string;
      candidate: ReviewDraftHistoryConflictCandidate;
    } | null = null;
    for (const sourceScopeHash of conflictScopes.scopeHashes) {
      const candidatePath = path.join(
        this.getConflictCandidateDirByScopeHash(teamName, scopeKey, sourceScopeHash),
        `${candidateId}.json`
      );
      try {
        const candidate = await this.loadConflictCandidateFromPath(
          candidatePath,
          scopeKey,
          sourceScopeHash,
          currentScopeHash
        );
        if (located) throw new Error('Ambiguous review draft history conflict candidate');
        located = { candidatePath, candidate };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    if (!located) throw new Error('Manual-edit recovery copy is unavailable');
    return located;
  }

  async loadConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<ReviewDraftHistoryConflictCandidate> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    const { candidate } = await this.locateConflictCandidate(
      teamName,
      scopeKey,
      scopeToken,
      candidateId
    );
    const stored = await this.readStored(teamName, scopeKey, scopeToken);
    const current = stored?.entries[candidate.filePath];
    return {
      ...candidate,
      observedCurrentRevision: current?.revision ?? 0,
      observedCurrentGeneration: current?.generation ?? null,
    };
  }

  async resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryEntry | null> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    if (
      (resolution !== 'recover-candidate' && resolution !== 'keep-current') ||
      !Number.isSafeInteger(expectedCurrentRevision) ||
      expectedCurrentRevision < 0 ||
      (expectedCurrentRevision === 0
        ? expectedCurrentGeneration !== null
        : !isValidGeneration(expectedCurrentGeneration))
    ) {
      throw new Error('Invalid review draft conflict resolution');
    }
    const { candidatePath, candidate } = await this.locateConflictCandidate(
      teamName,
      scopeKey,
      scopeToken,
      candidateId
    );
    const stored = await this.readStored(teamName, scopeKey, scopeToken);
    const current = stored?.entries[candidate.filePath];
    if (
      (current?.revision ?? 0) !== expectedCurrentRevision ||
      (current?.generation ?? null) !== expectedCurrentGeneration
    ) {
      throw new Error('Saved manual edit history changed again; reload recovery choices');
    }
    if (resolution === 'keep-current') {
      await unlinkPathDurably(candidatePath);
      return current ?? null;
    }
    if (candidate.entry === null) {
      if (!current) {
        await unlinkPathDurably(candidatePath);
        return null;
      }
      await this.writeConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        {
          filePath: current.filePath,
          codec: current.codec,
          revision: current.revision + 1,
          diskBaseline: current.diskBaseline,
          editorState: current.editorState,
          expectedRevision: current.revision,
          expectedGeneration: current.generation,
        },
        current.revision + 1,
        current.generation,
        candidatePath
      );
      await this.clearEntry(
        teamName,
        scopeKey,
        scopeToken,
        current.filePath,
        current.revision,
        current.generation
      );
      await unlinkPathDurably(candidatePath);
      return null;
    }
    if (
      current &&
      current.filePath === candidate.entry.filePath &&
      current.codec === candidate.entry.codec &&
      current.diskBaseline === candidate.entry.diskBaseline &&
      JSON.stringify(current.editorState) === JSON.stringify(candidate.entry.editorState)
    ) {
      await unlinkPathDurably(candidatePath);
      return current;
    }
    if (current) {
      // Preserve the canonical editor branch before publishing the selected recovery
      // branch. The backup is itself a normal candidate, so switching remains reversible.
      await this.writeConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        {
          filePath: current.filePath,
          codec: current.codec,
          revision: current.revision + 1,
          diskBaseline: current.diskBaseline,
          editorState: current.editorState,
          expectedRevision: current.revision,
          expectedGeneration: current.generation,
        },
        current.revision + 1,
        current.generation,
        candidatePath
      );
    } else {
      await this.writeEmptyConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        candidate.filePath,
        candidatePath
      );
    }
    const recovered = await this.saveEntry(teamName, scopeKey, scopeToken, {
      ...candidate.entry,
      expectedRevision: expectedCurrentRevision,
      expectedGeneration: expectedCurrentGeneration,
      revision: expectedCurrentRevision + 1,
    });
    await unlinkPathDurably(candidatePath);
    return recovered;
  }

  async replaceConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    expectedEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    replacementEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryConflictCandidate> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    const candidate = (
      await this.mapConflictCandidates(teamName, scopeKey, scopeToken, (entry) => ({
        id: entry.id,
        capturedAt: entry.capturedAt,
        candidate:
          entry.origin === 'current-snapshot' &&
          entry.entry &&
          conflictEntriesEqual(entry.entry, expectedEntry)
            ? entry
            : null,
      }))
    ).find((entry) => entry.candidate)?.candidate;
    if (!candidate) throw new Error('Manual-edit recovery predecessor is unavailable');
    const candidateId = candidate.id;
    const candidatePath = this.getConflictCandidatePath(
      teamName,
      scopeKey,
      scopeToken,
      candidateId
    );
    await this.ensureConflictCandidateDir(teamName, scopeKey, scopeToken);
    if (replacementEntry.filePath !== candidate.filePath) {
      throw new Error('Manual-edit recovery update changed file identity');
    }
    const input: SaveReviewDraftHistoryEntryInput = {
      ...replacementEntry,
      expectedRevision: candidate.expectedRevision,
      expectedGeneration: candidate.expectedGeneration,
    };
    this.assertEntry(input);
    const stored = await this.readStored(teamName, scopeKey, scopeToken);
    const current = stored?.entries[candidate.filePath];
    if (
      (current?.revision ?? 0) !== expectedCurrentRevision ||
      (current?.generation ?? null) !== expectedCurrentGeneration
    ) {
      throw new Error('Saved manual edit history changed again; reload recovery choices');
    }
    const replacement = await this.writeConflictCandidate(
      teamName,
      scopeKey,
      scopeToken,
      input,
      expectedCurrentRevision,
      expectedCurrentGeneration,
      candidatePath
    );
    if (replacement.id !== candidateId) {
      await unlinkPathDurably(candidatePath);
    }
    return replacement;
  }

  async saveEntry(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    input: SaveReviewDraftHistoryEntryInput
  ): Promise<ReviewDraftHistoryEntry> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    this.assertEntry(input);
    const stored = await this.readStored(teamName, scopeKey, scopeToken);
    const entries = { ...(stored?.entries ?? {}) };
    const existing = entries[input.filePath];
    const currentRevision = existing?.revision ?? 0;
    const currentGeneration = existing?.generation ?? null;
    if (
      input.expectedRevision !== currentRevision ||
      input.expectedGeneration !== currentGeneration
    ) {
      if (existing && entriesEqual(existing, input)) return existing;
      await this.writeConflictCandidate(
        teamName,
        scopeKey,
        scopeToken,
        input,
        currentRevision,
        currentGeneration
      );
      throw new Error('Review draft history changed; refusing stale state overwrite');
    }
    if (existing && entriesEqual(existing, input)) {
      return existing;
    }
    if (!existing && Object.keys(entries).length >= MAX_HISTORY_ENTRIES) {
      throw new Error('Too many review draft history entries');
    }
    const {
      expectedRevision: _expectedRevision,
      expectedGeneration: _expectedGeneration,
      ...entryInput
    } = input;
    const entry: ReviewDraftHistoryEntry = {
      ...entryInput,
      generation: randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    entries[input.filePath] = entry;
    await this.writeStored(teamName, scopeKey, scopeToken, entries);
    return entry;
  }

  async clearEntry(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    filePath: string,
    expectedRevision: number,
    expectedGeneration: string | null
  ): Promise<void> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    if (
      typeof filePath !== 'string' ||
      filePath.length === 0 ||
      filePath.length > MAX_FILE_PATH_LENGTH ||
      filePath.includes('\0')
    ) {
      throw new Error('Invalid review draft history file path');
    }
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      (expectedRevision === 0
        ? expectedGeneration !== null
        : !isValidGeneration(expectedGeneration))
    ) {
      throw new Error('Invalid review draft history revision');
    }
    const stored = await this.readStored(teamName, scopeKey, scopeToken);
    if (!stored || !(filePath in stored.entries)) return;
    if (
      stored.entries[filePath]?.revision !== expectedRevision ||
      stored.entries[filePath]?.generation !== expectedGeneration
    ) {
      throw new Error('Review draft history changed; refusing stale state overwrite');
    }
    const entries = { ...stored.entries };
    delete entries[filePath];
    if (Object.keys(entries).length === 0) {
      await unlinkPathDurably(this.getFilePath(teamName, scopeKey, scopeToken)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }
      );
      return;
    }
    await this.writeStored(teamName, scopeKey, scopeToken, entries);
  }

  async clearScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    const filePath = this.getFilePath(teamName, scopeKey, scopeToken);
    if (
      !(await assertConstrainedPersistenceDirectory(getTeamsBasePath(), path.dirname(filePath)))
    ) {
      return;
    }
    await unlinkPathDurably(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async clearUnreadableScope(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<void> {
    this.assertSafeScope(teamName, scopeKey, scopeToken);
    try {
      const current = await this.readStored(teamName, scopeKey, scopeToken);
      if (current) {
        throw new Error(
          'Saved manual edit history became readable; refusing destructive recovery discard'
        );
      }
      return;
    } catch (error) {
      if (!(error instanceof InvalidReviewDraftHistoryError)) throw error;
    }
    await this.clearScope(teamName, scopeKey, scopeToken);
  }
}
