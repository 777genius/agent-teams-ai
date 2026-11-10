import { createHash } from 'crypto';
import type {
  ReviewDraftHistoryConflictCandidate,
  ReviewDraftHistoryConflictCandidateSummary,
  ReviewDraftHistoryEntry,
  ReviewDraftHistoryJsonValue,
  ReviewDraftHistorySnapshot,
  ReviewSerializedEditorState,
} from './draftContracts.js';
import type { ReviewConflictResolution } from '../../contracts.js';

export const STORE_VERSION = 1;

export const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export const SCOPE_KEY_PATTERN = /^(?:task|agent)-[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;

export const MAX_SCOPE_TOKEN_LENGTH = 32 * 1024 * 1024;

export const MAX_FILE_PATH_LENGTH = 32 * 1024;

export const MAX_HISTORY_FILE_BYTES = 128 * 1024 * 1024;

export const MAX_HISTORY_ENTRY_BYTES = 32 * 1024 * 1024;

export const MAX_HISTORY_ENTRIES = 512;

export const MAX_GENERATION_LENGTH = 128;

export const MAX_EXACT_SCOPES_PER_LOGICAL_SCOPE = 16;

export const MAX_CONFLICT_CANDIDATES_PER_SCOPE = 32;

export const MAX_CONFLICT_CANDIDATES_PER_LOGICAL_SCOPE = 64;

export const MAX_JSON_DEPTH = 100;

export const MAX_JSON_NODES = 1_000_000;

export interface StoredReviewDraftHistory {
  version: 1;
  scopeKey: string;
  scopeTokenHash: string;
  entries: Record<string, ReviewDraftHistoryEntry>;
  updatedAt: string;
}

export interface StoredReviewDraftHistoryConflictCandidateV1 extends Omit<
  ReviewDraftHistoryConflictCandidate,
  'origin'
> {
  version: 1;
  scopeKey: string;
  scopeTokenHash: string;
  entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>;
}

export interface StoredReviewDraftHistoryConflictCandidateV2 extends Omit<
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

export class InvalidReviewDraftHistoryError extends Error {}

export function shouldQuarantineDraftConflictCandidate(error: unknown): boolean {
  if (error instanceof InvalidReviewDraftHistoryError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith('Unsafe review draft conflict candidate') ||
    error.message === 'Unsafe or oversized review draft conflict candidate' ||
    error.message === 'Review draft conflict candidate changed while being read'
  );
}

export function getScopeTokenHash(scopeToken: string): string {
  return createHash('sha256').update(scopeToken).digest('hex');
}

export function isJsonValue(value: unknown): value is ReviewDraftHistoryJsonValue {
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

export function isSerializedEditorState(value: unknown): value is ReviewSerializedEditorState {
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

export function entriesEqual(
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

export function conflictEntriesEqual(
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

export function isValidGeneration(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_GENERATION_LENGTH &&
    !value.includes('\0')
  );
}

export function getLegacyGeneration(entry: Omit<ReviewDraftHistoryEntry, 'generation'>): string {
  return `legacy-${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`;
}

export interface StorageLogger {
  warn(message: string): void;
  error(message: string): void;
}
export interface DraftContext {
  readonly teamsRoot: string;
  readonly logger: StorageLogger;
  assertSafeScope(teamName: string, scopeKey: string, scopeToken: string): void;
  assertEntry(input: SaveReviewDraftHistoryEntryInput): void;
  getScopeDir(teamName: string, scopeKey: string): string;
  getFilePath(teamName: string, scopeKey: string, scopeToken: string): string;
  getConflictCandidateDir(teamName: string, scopeKey: string, scopeToken: string): string;
  getConflictScopeDir(teamName: string, scopeKey: string): string;
  getConflictCandidateDirByScopeHash(teamName: string, scopeKey: string, scopeHash: string): string;
  inspectConflictScopes(
    teamName: string,
    scopeKey: string
  ): Promise<{ scopeHashes: Set<string>; candidatePaths: Set<string> }>;
  getConflictCandidatePath(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): string;
  ensureConflictCandidateDir(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<string>;
  parseStoredData(value: unknown, scopeKey: string, scopeToken: string): StoredReviewDraftHistory;
  readStored(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<StoredReviewDraftHistory | null>;
  writeStored(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    entries: Record<string, ReviewDraftHistoryEntry>
  ): Promise<void>;
  pruneScopeDir(teamName: string, scopeKey: string, protectedPath: string): Promise<void>;
  getConflictCandidateIdentityPayload(input: {
    scopeKey: string;
    scopeTokenHash: string;
    expectedRevision: number;
    expectedGeneration: string | null;
    filePath: string;
    entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'> | null;
  }): object;
  parseConflictCandidate(
    value: unknown,
    scopeKey: string,
    sourceScopeHash: string,
    currentScopeHash: string
  ): ReviewDraftHistoryConflictCandidate;
  loadConflictCandidateFromPath(
    filePath: string,
    scopeKey: string,
    sourceScopeHash: string,
    currentScopeHash: string
  ): Promise<ReviewDraftHistoryConflictCandidate>;
  assertConflictCandidateCapacity(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    protectedPath: string,
    replacementPath?: string
  ): Promise<void>;
  writeConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    input: SaveReviewDraftHistoryEntryInput,
    observedCurrentRevision: number,
    observedCurrentGeneration: string | null,
    replacementPath?: string
  ): Promise<ReviewDraftHistoryConflictCandidate>;
  writeEmptyConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    filePath: string,
    replacementPath?: string
  ): Promise<ReviewDraftHistoryConflictCandidate>;
  load(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistorySnapshot | null>;
  mapConflictCandidates<T extends { id: string; capturedAt: string }>(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    mapCandidate: (candidate: ReviewDraftHistoryConflictCandidate) => T
  ): Promise<T[]>;
  loadConflictCandidates(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistoryConflictCandidate[]>;
  loadConflictCandidateSummaries(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistoryConflictCandidateSummary[]>;
  locateConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<{ candidatePath: string; candidate: ReviewDraftHistoryConflictCandidate }>;
  loadConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<ReviewDraftHistoryConflictCandidate>;
  resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryEntry | null>;
  replaceConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    expectedEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    replacementEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryConflictCandidate>;
  saveEntry(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    input: SaveReviewDraftHistoryEntryInput
  ): Promise<ReviewDraftHistoryEntry>;
  clearEntry(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    filePath: string,
    expectedRevision: number,
    expectedGeneration: string | null
  ): Promise<void>;
  clearScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void>;
  clearUnreadableScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void>;
}
