/**
 * SessionMetadataIndex - persisted read-through cache for session listing metadata.
 *
 * The index is never a source of truth. Callers may use an entry only when the
 * current file signature (mtimeMs + size) matches the indexed signature.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { createLogger } from '@shared/utils/logger';

import type { SessionFileMetadata } from '@main/utils/jsonl';

const logger = createLogger('Discovery:SessionMetadataIndex');

const SESSION_METADATA_INDEX_SCHEMA_VERSION = 1;
const DEFAULT_PERSIST_DELAY_MS = 250;

export interface SessionMetadataIndexOptions {
  rootDir: string;
  persistDelayMs?: number;
}

export interface SessionFileSignature {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  size: number;
  birthtimeMs?: number;
}

interface SessionMetadataIndexEntry extends SessionFileSignature {
  hasContent?: boolean;
  metadata?: SessionFileMetadata;
  updatedAt: number;
}

interface SessionMetadataIndexFile {
  schemaVersion: number;
  projectStorageDir: string;
  updatedAt: number;
  sessions: Record<string, SessionMetadataIndexEntry>;
}

interface LoadedProjectIndex {
  file: SessionMetadataIndexFile;
  dirty: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persistPromise: Promise<void> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnProperty(value: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sanitizePathSegment(value: string): string {
  const replaced = value.replace(/[^a-zA-Z0-9._-]/g, '-');
  let start = 0;
  let end = replaced.length;
  while (start < end && replaced[start] === '-') {
    start += 1;
  }
  while (end > start && replaced[end - 1] === '-') {
    end -= 1;
  }
  const sanitized = replaced.slice(start, end);
  return sanitized.length > 0 ? sanitized.slice(0, 80) : 'project';
}

function hashProjectStorageDir(projectStorageDir: string): string {
  return crypto.createHash('sha256').update(projectStorageDir).digest('hex').slice(0, 16);
}

function createEmptyIndex(projectStorageDir: string): SessionMetadataIndexFile {
  return {
    schemaVersion: SESSION_METADATA_INDEX_SCHEMA_VERSION,
    projectStorageDir,
    updatedAt: Date.now(),
    sessions: {},
  };
}

function normalizeFirstUserMessage(
  value: unknown
): SessionFileMetadata['firstUserMessage'] | undefined {
  if (value === null) {
    return null;
  }
  if (isRecord(value) && typeof value.text === 'string' && typeof value.timestamp === 'string') {
    return {
      text: value.text,
      timestamp: value.timestamp,
    };
  }
  return undefined;
}

function normalizePhaseBreakdown(
  value: unknown
): SessionFileMetadata['phaseBreakdown'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const phases: NonNullable<SessionFileMetadata['phaseBreakdown']> = [];
  for (const phase of value) {
    if (
      !isRecord(phase) ||
      !isNonNegativeInteger(phase.phaseNumber) ||
      !isNonNegativeInteger(phase.contribution) ||
      !isNonNegativeInteger(phase.peakTokens) ||
      (hasOwnProperty(phase, 'postCompaction') && !isNonNegativeInteger(phase.postCompaction))
    ) {
      return undefined;
    }

    phases.push({
      phaseNumber: phase.phaseNumber,
      contribution: phase.contribution,
      peakTokens: phase.peakTokens,
      ...(isNonNegativeInteger(phase.postCompaction)
        ? { postCompaction: phase.postCompaction }
        : {}),
    });
  }

  return phases;
}

function normalizeMetadata(value: unknown): SessionFileMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const firstUserMessage = normalizeFirstUserMessage(value.firstUserMessage);
  if (
    firstUserMessage === undefined ||
    !isNonNegativeInteger(value.messageCount) ||
    typeof value.isOngoing !== 'boolean' ||
    !(value.gitBranch === null || typeof value.gitBranch === 'string')
  ) {
    return undefined;
  }

  const metadata: SessionFileMetadata = {
    firstUserMessage,
    messageCount: value.messageCount,
    isOngoing: value.isOngoing,
    gitBranch: value.gitBranch,
  };

  if (hasOwnProperty(value, 'model')) {
    if (!(value.model === null || typeof value.model === 'string')) {
      return undefined;
    }
    metadata.model = value.model;
  }
  if (hasOwnProperty(value, 'contextConsumption')) {
    if (!isNonNegativeInteger(value.contextConsumption)) {
      return undefined;
    }
    metadata.contextConsumption = value.contextConsumption;
  }
  if (hasOwnProperty(value, 'compactionCount')) {
    if (!isNonNegativeInteger(value.compactionCount)) {
      return undefined;
    }
    metadata.compactionCount = value.compactionCount;
  }

  if (hasOwnProperty(value, 'phaseBreakdown')) {
    const phaseBreakdown = normalizePhaseBreakdown(value.phaseBreakdown);
    if (!phaseBreakdown) {
      return undefined;
    }
    metadata.phaseBreakdown = phaseBreakdown;
  }

  return metadata;
}

function normalizeEntry(value: unknown): SessionMetadataIndexEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.sessionId !== 'string' ||
    typeof value.filePath !== 'string' ||
    !isNonNegativeFiniteNumber(value.mtimeMs) ||
    !isNonNegativeInteger(value.size) ||
    !isNonNegativeFiniteNumber(value.updatedAt)
  ) {
    return null;
  }

  const entry: SessionMetadataIndexEntry = {
    sessionId: value.sessionId,
    filePath: value.filePath,
    mtimeMs: value.mtimeMs,
    size: value.size,
    updatedAt: value.updatedAt,
  };

  if (hasOwnProperty(value, 'birthtimeMs')) {
    if (!isNonNegativeFiniteNumber(value.birthtimeMs)) {
      return null;
    }
    entry.birthtimeMs = value.birthtimeMs;
  }
  if (hasOwnProperty(value, 'hasContent')) {
    if (typeof value.hasContent !== 'boolean') {
      return null;
    }
    entry.hasContent = value.hasContent;
  }
  const metadata = normalizeMetadata(value.metadata);
  if (metadata) {
    entry.metadata = metadata;
  } else if (hasOwnProperty(value, 'metadata')) {
    return null;
  }

  return entry;
}

function normalizeIndexFile(
  value: unknown,
  projectStorageDir: string
): SessionMetadataIndexFile | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.schemaVersion !== SESSION_METADATA_INDEX_SCHEMA_VERSION ||
    value.projectStorageDir !== projectStorageDir ||
    !isRecord(value.sessions)
  ) {
    return null;
  }

  const sessions: Record<string, SessionMetadataIndexEntry> = {};
  for (const [key, rawEntry] of Object.entries(value.sessions)) {
    const entry = normalizeEntry(rawEntry);
    if (key === entry?.filePath) {
      sessions[key] = entry;
    }
  }

  return {
    schemaVersion: SESSION_METADATA_INDEX_SCHEMA_VERSION,
    projectStorageDir,
    updatedAt: isNonNegativeFiniteNumber(value.updatedAt) ? value.updatedAt : Date.now(),
    sessions,
  };
}

function isFreshEntry(
  entry: SessionMetadataIndexEntry | undefined,
  signature: Pick<SessionFileSignature, 'sessionId' | 'filePath' | 'mtimeMs' | 'size'>
): entry is SessionMetadataIndexEntry {
  return (
    Boolean(entry) &&
    entry!.sessionId === signature.sessionId &&
    entry!.filePath === signature.filePath &&
    entry!.mtimeMs === signature.mtimeMs &&
    entry!.size === signature.size
  );
}

export class SessionMetadataIndex {
  private readonly rootDir: string;
  private readonly persistDelayMs: number;
  private readonly indexes = new Map<string, LoadedProjectIndex>();
  private readonly loads = new Map<string, Promise<LoadedProjectIndex>>();

  constructor(options: SessionMetadataIndexOptions) {
    this.rootDir = options.rootDir;
    this.persistDelayMs = options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS;
  }

  static getIndexPath(rootDir: string, projectStorageDir: string): string {
    const basename = sanitizePathSegment(path.basename(projectStorageDir));
    const hash = hashProjectStorageDir(projectStorageDir);
    return path.join(rootDir, `${basename}-${hash}.json`);
  }

  async getContentPresence(signature: SessionFileSignature): Promise<boolean | undefined> {
    const index = await this.loadProjectIndex(path.dirname(signature.filePath));
    const entry = index.file.sessions[signature.filePath];
    if (!isFreshEntry(entry, signature)) {
      return undefined;
    }
    return typeof entry.hasContent === 'boolean' ? entry.hasContent : undefined;
  }

  async setContentPresence(signature: SessionFileSignature, hasContent: boolean): Promise<void> {
    const projectStorageDir = path.dirname(signature.filePath);
    const index = await this.loadProjectIndex(projectStorageDir);
    const entry = this.getOrCreateEntry(index.file, signature);
    entry.hasContent = hasContent;
    entry.updatedAt = Date.now();
    this.markDirty(projectStorageDir, index);
  }

  async getMetadata(signature: SessionFileSignature): Promise<SessionFileMetadata | undefined> {
    const index = await this.loadProjectIndex(path.dirname(signature.filePath));
    const entry = index.file.sessions[signature.filePath];
    if (!isFreshEntry(entry, signature)) {
      return undefined;
    }
    return entry.metadata;
  }

  async setMetadata(signature: SessionFileSignature, metadata: SessionFileMetadata): Promise<void> {
    const projectStorageDir = path.dirname(signature.filePath);
    const index = await this.loadProjectIndex(projectStorageDir);
    const entry = this.getOrCreateEntry(index.file, signature);
    entry.metadata = metadata;
    entry.updatedAt = Date.now();
    this.markDirty(projectStorageDir, index);
  }

  async pruneMissing(projectStorageDir: string, existingFilePaths: Set<string>): Promise<void> {
    const index = await this.loadProjectIndex(projectStorageDir);
    let changed = false;
    for (const filePath of Object.keys(index.file.sessions)) {
      if (!existingFilePaths.has(filePath)) {
        delete index.file.sessions[filePath];
        changed = true;
      }
    }
    if (changed) {
      this.markDirty(projectStorageDir, index);
    }
  }

  async flushForTesting(): Promise<void> {
    for (const [projectStorageDir, index] of this.indexes.entries()) {
      if (index.persistTimer) {
        clearTimeout(index.persistTimer);
        index.persistTimer = null;
      }

      while (index.dirty || index.persistPromise) {
        if (index.dirty) {
          this.startPersist(projectStorageDir, index);
        }
        await (index.persistPromise ?? Promise.resolve());
      }
    }
  }

  private getOrCreateEntry(
    index: SessionMetadataIndexFile,
    signature: SessionFileSignature
  ): SessionMetadataIndexEntry {
    const existing = index.sessions[signature.filePath];
    if (isFreshEntry(existing, signature)) {
      if (isNonNegativeFiniteNumber(signature.birthtimeMs)) {
        existing.birthtimeMs = signature.birthtimeMs;
      }
      return existing;
    }

    const entry: SessionMetadataIndexEntry = {
      sessionId: signature.sessionId,
      filePath: signature.filePath,
      mtimeMs: signature.mtimeMs,
      size: signature.size,
      updatedAt: Date.now(),
    };
    if (isNonNegativeFiniteNumber(signature.birthtimeMs)) {
      entry.birthtimeMs = signature.birthtimeMs;
    }
    index.sessions[signature.filePath] = entry;
    return entry;
  }

  private async loadProjectIndex(projectStorageDir: string): Promise<LoadedProjectIndex> {
    const cached = this.indexes.get(projectStorageDir);
    if (cached) {
      return cached;
    }

    const existingLoad = this.loads.get(projectStorageDir);
    if (existingLoad) {
      return existingLoad;
    }

    const load = this.readProjectIndex(projectStorageDir).finally(() => {
      this.loads.delete(projectStorageDir);
    });
    this.loads.set(projectStorageDir, load);
    return load;
  }

  private async readProjectIndex(projectStorageDir: string): Promise<LoadedProjectIndex> {
    const indexPath = SessionMetadataIndex.getIndexPath(this.rootDir, projectStorageDir);
    let file = createEmptyIndex(projectStorageDir);
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const parsed = normalizeIndexFile(JSON.parse(raw), projectStorageDir);
      if (parsed) {
        file = parsed;
      }
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (code !== 'ENOENT') {
        logger.debug(
          `Ignoring unreadable session metadata index ${indexPath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const loaded: LoadedProjectIndex = {
      file,
      dirty: false,
      persistTimer: null,
      persistPromise: null,
    };
    this.indexes.set(projectStorageDir, loaded);
    return loaded;
  }

  private markDirty(projectStorageDir: string, index: LoadedProjectIndex): void {
    index.file.updatedAt = Date.now();
    index.dirty = true;

    if (this.persistDelayMs <= 0) {
      this.startPersist(projectStorageDir, index);
      return;
    }

    if (index.persistTimer) {
      return;
    }

    index.persistTimer = setTimeout(() => {
      index.persistTimer = null;
      this.startPersist(projectStorageDir, index);
    }, this.persistDelayMs);
    index.persistTimer.unref?.();
  }

  private startPersist(projectStorageDir: string, index: LoadedProjectIndex): void {
    if (index.persistPromise) {
      return;
    }

    const promise = this.persistProjectIndex(projectStorageDir, index).finally(() => {
      if (index.persistPromise === promise) {
        index.persistPromise = null;
      }
      if (index.dirty) {
        this.markDirty(projectStorageDir, index);
      }
    });
    index.persistPromise = promise;
  }

  private async persistProjectIndex(
    projectStorageDir: string,
    index: LoadedProjectIndex
  ): Promise<void> {
    if (!index.dirty) {
      return;
    }

    const indexPath = SessionMetadataIndex.getIndexPath(this.rootDir, projectStorageDir);
    const serialized = `${JSON.stringify(index.file)}\n`;
    index.dirty = false;

    try {
      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      await atomicWriteAsync(indexPath, serialized, { mode: 0o600 });
    } catch (error) {
      logger.debug(
        `Failed to persist session metadata index ${indexPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
