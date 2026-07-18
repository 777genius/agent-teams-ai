import { atomicWriteAsync, unlinkPathDurably } from '@main/utils/atomicWrite';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type {
  ReviewDraftHistoryEntry,
  ReviewDraftHistoryJsonValue,
  ReviewDraftHistorySnapshot,
  ReviewSerializedEditorState,
} from '@features/change-review-history/contracts';

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
const MAX_JSON_DEPTH = 100;
const MAX_JSON_NODES = 1_000_000;

interface StoredReviewDraftHistory {
  version: 1;
  scopeKey: string;
  scopeTokenHash: string;
  entries: Record<string, ReviewDraftHistoryEntry>;
  updatedAt: string;
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
    await atomicWriteAsync(this.getFilePath(teamName, scopeKey, scopeToken), serialized, {
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
          } catch {
            return null;
          }
        })
    );
    const stale = candidates
      .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
      .sort((left, right) => {
        if (left.filePath === protectedPath) return -1;
        if (right.filePath === protectedPath) return 1;
        return right.mtimeMs - left.mtimeMs;
      })
      .slice(MAX_EXACT_SCOPES_PER_LOGICAL_SCOPE);
    await Promise.all(
      stale.map((entry) => unlinkPathDurably(entry.filePath).catch(() => undefined))
    );
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
    await unlinkPathDurably(this.getFilePath(teamName, scopeKey, scopeToken)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      }
    );
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
