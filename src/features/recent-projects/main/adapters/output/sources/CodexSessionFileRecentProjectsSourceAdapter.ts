import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveProjectFilesystemState } from '@features/recent-projects/main/infrastructure/filesystem/resolveProjectFilesystemState';
import { normalizeIdentityPath } from '@features/recent-projects/main/infrastructure/identity/normalizeIdentityPath';
import { getAppDataPath } from '@main/utils/pathDecoder';
import { isEphemeralProjectPath } from '@shared/utils/ephemeralProjectPath';

import type { LoggerPort } from '@features/recent-projects/core/application/ports/LoggerPort';
import type {
  RecentProjectsSourcePort,
  RecentProjectsSourceResult,
} from '@features/recent-projects/core/application/ports/RecentProjectsSourcePort';
import type { RecentProjectCandidate } from '@features/recent-projects/core/domain/models/RecentProjectCandidate';
import type { RecentProjectIdentityResolver } from '@features/recent-projects/main/infrastructure/identity/RecentProjectIdentityResolver';
import type { ServiceContext } from '@main/services';

const CODEX_SESSION_FILE_PARSE_LIMIT = 500;
const CODEX_PROJECT_CANDIDATE_LIMIT = 40;
const CODEX_SESSION_FILE_SOURCE_TIMEOUT_MS = 8_000;
const CODEX_SESSION_FILE_SOFT_BUDGET_MS = 6_500;
const CODEX_SESSION_FILE_MAX_UNCACHED_READS_PER_RUN = 160;
const CODEX_SESSION_FILE_READ_BATCH_SIZE = 24;
const CODEX_SESSION_FILE_READ_TIMEOUT_MS = 700;
const CODEX_SESSION_FILE_DISCOVERY_STAT_BATCH_SIZE = 64;
const CODEX_SESSION_METADATA_READ_LIMIT_BYTES = 128 * 1024;
const CODEX_SESSION_FILE_CACHE_SCHEMA_VERSION = 1;
const CODEX_SESSION_FILE_CACHE_RELATIVE_PATH = path.join(
  'recent-projects',
  'codex-session-files-index.json'
);
const CODEX_SESSION_FILE_CACHE_MAX_BYTES = 4 * 1024 * 1024;

interface CodexSessionFileEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
}

interface CodexSessionEvent {
  timestamp?: unknown;
  payload?: {
    cwd?: unknown;
    source?: unknown;
    timestamp?: unknown;
    git?: {
      branch?: unknown;
    } | null;
  };
}

interface CodexSessionProjectSnapshot {
  cwd: string;
  source: unknown;
  lastActivityAt: number;
  branchName?: string;
}

interface CodexSessionMetadata {
  cwd: string;
  source: unknown;
  payloadTimestamp?: unknown;
  eventTimestamp?: unknown;
  branchName?: string;
}

interface CodexSessionFileCacheEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
  snapshot: CodexSessionProjectSnapshot | null;
}

interface CodexSessionFileCacheFile {
  schemaVersion: number;
  entries: Record<string, CodexSessionFileCacheEntry>;
}

interface CodexSessionSnapshotLoadResult {
  snapshots: CodexSessionProjectSnapshot[];
  degraded: boolean;
  stats: {
    files: number;
    visitedFiles: number;
    droppedOlderFiles: number;
    statFailures: number;
    directoriesVisited: number;
    discoveryTimedOut: boolean;
    cached: number;
    uncachedReads: number;
    timedOutReads: number;
    skippedUncached: number;
    durationMs: number;
  };
}

interface CodexSessionFileListingResult {
  files: CodexSessionFileEntry[];
  visitedFiles: number;
  statFailures: number;
  directoriesVisited: number;
  timedOut: boolean;
}

interface InFlightListRequest {
  contextKey: string;
  promise: Promise<RecentProjectsSourceResult>;
}

function emptyCache(): CodexSessionFileCacheFile {
  return {
    schemaVersion: CODEX_SESSION_FILE_CACHE_SCHEMA_VERSION,
    entries: {},
  };
}

function captureMemoryDiagnostics(): {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
} {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
  };
}

function isUsableCacheEntry(
  entry: CodexSessionFileCacheEntry | undefined,
  file: CodexSessionFileEntry
): entry is CodexSessionFileCacheEntry {
  return (
    !!entry &&
    entry.filePath === file.filePath &&
    entry.mtimeMs === file.mtimeMs &&
    entry.size === file.size
  );
}

function isInteractiveSource(source: unknown): boolean {
  return source === 'vscode' || source === 'cli';
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

function getCodexHome(codexHome?: string): string {
  return codexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

function extractJsonStringField(input: string, fieldName: string): string {
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const match = pattern.exec(input);
  if (!match) return '';

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return '';
  }
}

function parseSessionMetadataPrefix(firstLine: string): CodexSessionMetadata | null {
  const cwd = extractJsonStringField(firstLine, 'cwd').trim();
  const source = extractJsonStringField(firstLine, 'source').trim();
  if (!cwd || !source) return null;

  return {
    cwd,
    source,
    payloadTimestamp: extractJsonStringField(firstLine, 'timestamp'),
    eventTimestamp: extractJsonStringField(firstLine, 'timestamp'),
    branchName: extractJsonStringField(firstLine, 'branch').trim() || undefined,
  };
}

async function readFirstLine(filePath: string): Promise<string | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(CODEX_SESSION_METADATA_READ_LIMIT_BYTES);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead <= 0) return null;

    const newlineIndex = buffer.subarray(0, result.bytesRead).indexOf(0x0a);
    const endIndex = newlineIndex >= 0 ? newlineIndex : result.bytesRead;
    return buffer.toString('utf8', 0, endIndex);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readFirstLineWithTimeout(
  filePath: string,
  timeoutMs: number
): Promise<{ firstLine: string | null; timedOut: boolean }> {
  if (timeoutMs <= 0) {
    return {
      firstLine: null,
      timedOut: true,
    };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const readPromise = readFirstLine(filePath)
    .then((firstLine) => ({
      firstLine,
      timedOut: false,
    }))
    .catch(() => ({
      firstLine: null,
      timedOut: false,
    }));
  const timeoutPromise = new Promise<{ firstLine: null; timedOut: true }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          firstLine: null,
          timedOut: true,
        }),
      timeoutMs
    );
  });

  const result = await Promise.race([readPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

function insertRecentSessionFile(
  files: CodexSessionFileEntry[],
  file: CodexSessionFileEntry,
  limit: number
): void {
  if (limit <= 0) {
    return;
  }

  if (files.length >= limit && file.mtimeMs <= files[files.length - 1].mtimeMs) {
    return;
  }

  let low = 0;
  let high = files.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (file.mtimeMs > files[mid].mtimeMs) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  files.splice(low, 0, file);
  if (files.length > limit) {
    files.pop();
  }
}

function selectMostRecentSessionFiles(
  files: CodexSessionFileEntry[],
  limit: number
): CodexSessionFileEntry[] {
  const selected: CodexSessionFileEntry[] = [];
  for (const file of files) {
    insertRecentSessionFile(selected, file, limit);
  }
  return selected;
}

async function listRecentJsonlFiles(
  root: string,
  maxDepth: number,
  limit: number,
  deadlineMs: number
): Promise<CodexSessionFileListingResult> {
  const selectedFiles: CodexSessionFileEntry[] = [];
  let visitedFiles = 0;
  let statFailures = 0;
  let directoriesVisited = 0;
  let timedOut = false;

  const hasBudget = (): boolean => {
    if (Date.now() < deadlineMs) {
      return true;
    }
    timedOut = true;
    return false;
  };

  async function statJsonlFile(filePath: string): Promise<CodexSessionFileEntry | null> {
    if (!hasBudget()) {
      return null;
    }
    visitedFiles += 1;
    try {
      const stats = await fs.stat(filePath);
      return {
        filePath,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    } catch {
      statFailures += 1;
      return null;
    }
  }

  async function collectFileStats(filePaths: string[]): Promise<void> {
    for (
      let offset = 0;
      offset < filePaths.length && hasBudget();
      offset += CODEX_SESSION_FILE_DISCOVERY_STAT_BATCH_SIZE
    ) {
      const batch = filePaths.slice(offset, offset + CODEX_SESSION_FILE_DISCOVERY_STAT_BATCH_SIZE);
      const stats = await Promise.all(batch.map((filePath) => statJsonlFile(filePath)));
      for (const file of stats) {
        if (file) {
          insertRecentSessionFile(selectedFiles, file, limit);
        }
      }
    }
  }

  async function walk(directory: string, depth: number): Promise<void> {
    if (!hasBudget()) {
      return;
    }
    let directoryHandle;
    try {
      directoryHandle = await fs.opendir(directory, { encoding: 'utf8' });
    } catch {
      return;
    }

    directoriesVisited += 1;
    const fileBatch: string[] = [];
    const childDirectories: string[] = [];
    const flushFileBatch = async (): Promise<void> => {
      if (!fileBatch.length) {
        return;
      }
      const batch = fileBatch.splice(0, fileBatch.length);
      await collectFileStats(batch);
    };

    try {
      for await (const entry of directoryHandle) {
        if (!hasBudget()) {
          return;
        }

        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (depth < maxDepth) {
            childDirectories.push(entryPath);
          }
          continue;
        }

        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          fileBatch.push(entryPath);
          if (fileBatch.length >= CODEX_SESSION_FILE_DISCOVERY_STAT_BATCH_SIZE) {
            await flushFileBatch();
          }
        }
      }
    } catch {
      return;
    }

    await flushFileBatch();

    for (const childDirectory of childDirectories) {
      if (!hasBudget()) {
        return;
      }
      await walk(childDirectory, depth + 1);
    }
  }

  await walk(root, 0);

  return {
    files: selectedFiles,
    visitedFiles,
    statFailures,
    directoriesVisited,
    timedOut,
  };
}

function parseSessionSnapshot(
  firstLine: string,
  mtimeMs: number
): CodexSessionProjectSnapshot | null {
  let metadata: CodexSessionMetadata | null = null;
  try {
    const event = JSON.parse(firstLine) as CodexSessionEvent;
    metadata = {
      cwd: typeof event.payload?.cwd === 'string' ? event.payload.cwd.trim() : '',
      source: event.payload?.source,
      payloadTimestamp: event.payload?.timestamp,
      eventTimestamp: event.timestamp,
      branchName:
        typeof event.payload?.git?.branch === 'string' ? event.payload.git.branch.trim() : '',
    };
  } catch {
    metadata = parseSessionMetadataPrefix(firstLine);
  }

  const cwd = metadata?.cwd ?? '';
  if (!metadata || !cwd || !isInteractiveSource(metadata.source) || isEphemeralProjectPath(cwd)) {
    return null;
  }

  const timestamp =
    mtimeMs ||
    normalizeTimestamp(metadata.payloadTimestamp) ||
    normalizeTimestamp(metadata.eventTimestamp);

  return {
    cwd,
    source: metadata.source,
    lastActivityAt: timestamp,
    branchName: metadata.branchName || undefined,
  };
}

export class CodexSessionFileRecentProjectsSourceAdapter implements RecentProjectsSourcePort {
  readonly sourceId = 'codex-session-files';
  readonly timeoutMs = CODEX_SESSION_FILE_SOURCE_TIMEOUT_MS;
  readonly #codexHome: string;
  readonly #cachePath: string;
  #inFlightList: InFlightListRequest | null = null;

  constructor(
    private readonly deps: {
      getActiveContext: () => ServiceContext;
      getLocalContext: () => ServiceContext | undefined;
      identityResolver: RecentProjectIdentityResolver;
      logger: LoggerPort;
      codexHome?: string;
      appDataPath?: string;
    }
  ) {
    this.#codexHome = getCodexHome(deps.codexHome);
    this.#cachePath = path.join(
      deps.appDataPath ?? getAppDataPath(),
      CODEX_SESSION_FILE_CACHE_RELATIVE_PATH
    );
  }

  async list(): Promise<RecentProjectsSourceResult> {
    const activeContext = this.deps.getActiveContext();
    const localContext = this.deps.getLocalContext();

    if (activeContext.type !== 'local' || activeContext.id !== localContext?.id) {
      return {
        candidates: [],
        degraded: false,
      };
    }

    const contextKey = `${activeContext.type}:${activeContext.id}`;
    if (this.#inFlightList?.contextKey === contextKey) {
      return this.#inFlightList.promise;
    }

    const request = this.#listLocal(activeContext).finally(() => {
      if (this.#inFlightList?.promise === request) {
        this.#inFlightList = null;
      }
    });
    this.#inFlightList = { contextKey, promise: request };
    return request;
  }

  async #listLocal(activeContext: ServiceContext): Promise<RecentProjectsSourceResult> {
    try {
      const snapshotResult = await this.#listRecentSessionSnapshots();
      const candidates = await Promise.all(
        snapshotResult.snapshots.map((snapshot) =>
          this.#toCandidate(snapshot, activeContext.fsProvider)
        )
      );

      const validCandidates = candidates.filter(
        (candidate): candidate is RecentProjectCandidate => candidate !== null
      );

      this.deps.logger.info('codex session-file recent-projects source loaded', {
        count: validCandidates.length,
        codexHome: this.#codexHome,
        degraded: snapshotResult.degraded,
        ...captureMemoryDiagnostics(),
        ...snapshotResult.stats,
      });

      return {
        candidates: validCandidates,
        degraded: snapshotResult.degraded,
      };
    } catch (error) {
      this.deps.logger.warn('codex session-file recent-projects source failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        candidates: [],
        degraded: true,
      };
    }
  }

  async #listRecentSessionSnapshots(): Promise<CodexSessionSnapshotLoadResult> {
    const startedAt = Date.now();
    const deadline = startedAt + CODEX_SESSION_FILE_SOFT_BUDGET_MS;
    const sessionFiles = await listRecentJsonlFiles(
      path.join(this.#codexHome, 'sessions'),
      4,
      CODEX_SESSION_FILE_PARSE_LIMIT,
      deadline
    );
    const archivedSessionFiles = await listRecentJsonlFiles(
      path.join(this.#codexHome, 'archived_sessions'),
      1,
      CODEX_SESSION_FILE_PARSE_LIMIT,
      deadline
    );
    const files = selectMostRecentSessionFiles(
      [...sessionFiles.files, ...archivedSessionFiles.files],
      CODEX_SESSION_FILE_PARSE_LIMIT
    );
    const visitedFiles = sessionFiles.visitedFiles + archivedSessionFiles.visitedFiles;
    const statFailures = sessionFiles.statFailures + archivedSessionFiles.statFailures;
    const directoriesVisited =
      sessionFiles.directoriesVisited + archivedSessionFiles.directoriesVisited;
    const droppedOlderFiles = Math.max(0, visitedFiles - statFailures - files.length);
    const discoveryTimedOut = sessionFiles.timedOut || archivedSessionFiles.timedOut;

    const snapshotsByCwd = new Map<string, CodexSessionProjectSnapshot>();
    const candidateFiles = files;
    const cache = await this.#readCacheSafe();
    const nextCacheEntries = new Map<string, CodexSessionFileCacheEntry>();
    let degraded = discoveryTimedOut;
    let cached = 0;
    let uncachedReads = 0;
    let timedOutReads = 0;
    let skippedUncached = 0;

    for (
      let offset = 0;
      offset < candidateFiles.length && snapshotsByCwd.size < CODEX_PROJECT_CANDIDATE_LIMIT;
      offset += CODEX_SESSION_FILE_READ_BATCH_SIZE
    ) {
      const batch = candidateFiles.slice(offset, offset + CODEX_SESSION_FILE_READ_BATCH_SIZE);
      const metadata = await Promise.all(
        batch.map(async (file) => {
          const cachedEntry = cache.entries[file.filePath];
          if (isUsableCacheEntry(cachedEntry, file)) {
            cached += 1;
            nextCacheEntries.set(file.filePath, cachedEntry);
            return { snapshot: cachedEntry.snapshot, processed: true };
          }

          if (
            Date.now() >= deadline ||
            uncachedReads >= CODEX_SESSION_FILE_MAX_UNCACHED_READS_PER_RUN
          ) {
            degraded = true;
            skippedUncached += 1;
            return { snapshot: null, processed: false };
          }

          uncachedReads += 1;
          const readResult = await readFirstLineWithTimeout(
            file.filePath,
            Math.min(CODEX_SESSION_FILE_READ_TIMEOUT_MS, deadline - Date.now())
          );
          if (readResult.timedOut) {
            degraded = true;
            timedOutReads += 1;
            return { snapshot: null, processed: false };
          }

          const firstLine = readResult.firstLine;
          const snapshot = firstLine ? parseSessionSnapshot(firstLine, file.mtimeMs) : null;
          nextCacheEntries.set(file.filePath, {
            filePath: file.filePath,
            mtimeMs: file.mtimeMs,
            size: file.size,
            snapshot,
          });
          return { snapshot, processed: true };
        })
      );

      for (const { snapshot, processed } of metadata) {
        if (!processed || !snapshot) {
          continue;
        }

        const previous = snapshotsByCwd.get(snapshot.cwd);
        if (!previous || snapshot.lastActivityAt > previous.lastActivityAt) {
          snapshotsByCwd.set(snapshot.cwd, snapshot);
        }

        if (snapshotsByCwd.size >= CODEX_PROJECT_CANDIDATE_LIMIT) {
          break;
        }
      }
    }

    for (const file of candidateFiles) {
      const cachedEntry = cache.entries[file.filePath];
      if (isUsableCacheEntry(cachedEntry, file) && !nextCacheEntries.has(file.filePath)) {
        nextCacheEntries.set(file.filePath, cachedEntry);
      }
    }
    await this.#writeCacheSafe(nextCacheEntries);

    const snapshots = Array.from(snapshotsByCwd.values())
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
      .slice(0, CODEX_PROJECT_CANDIDATE_LIMIT);
    const durationMs = Date.now() - startedAt;
    if (degraded) {
      this.deps.logger.warn('codex session-file recent-projects source partial', {
        files: candidateFiles.length,
        visitedFiles,
        droppedOlderFiles,
        statFailures,
        directoriesVisited,
        discoveryTimedOut,
        ...captureMemoryDiagnostics(),
        cached,
        uncachedReads,
        timedOutReads,
        skippedUncached,
        candidates: snapshots.length,
        durationMs,
      });
    }

    return {
      snapshots,
      degraded,
      stats: {
        files: candidateFiles.length,
        visitedFiles,
        droppedOlderFiles,
        statFailures,
        directoriesVisited,
        discoveryTimedOut,
        cached,
        uncachedReads,
        timedOutReads,
        skippedUncached,
        durationMs,
      },
    };
  }

  async #readCacheSafe(): Promise<CodexSessionFileCacheFile> {
    try {
      const stats = await fs.stat(this.#cachePath);
      if (stats.size > CODEX_SESSION_FILE_CACHE_MAX_BYTES) {
        this.deps.logger.warn('codex session-file recent-projects cache skipped - too large', {
          cachePath: this.#cachePath,
          bytes: stats.size,
          maxBytes: CODEX_SESSION_FILE_CACHE_MAX_BYTES,
        });
        return emptyCache();
      }

      const raw = await fs.readFile(this.#cachePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CodexSessionFileCacheFile>;
      if (
        parsed.schemaVersion !== CODEX_SESSION_FILE_CACHE_SCHEMA_VERSION ||
        !parsed.entries ||
        typeof parsed.entries !== 'object' ||
        Array.isArray(parsed.entries)
      ) {
        return emptyCache();
      }
      return {
        schemaVersion: CODEX_SESSION_FILE_CACHE_SCHEMA_VERSION,
        entries: parsed.entries,
      };
    } catch {
      return emptyCache();
    }
  }

  async #writeCacheSafe(entries: ReadonlyMap<string, CodexSessionFileCacheEntry>): Promise<void> {
    let tempPath: string | null = null;
    try {
      await fs.mkdir(path.dirname(this.#cachePath), { recursive: true });
      const cacheFile: CodexSessionFileCacheFile = {
        schemaVersion: CODEX_SESSION_FILE_CACHE_SCHEMA_VERSION,
        entries: Object.fromEntries(entries),
      };
      tempPath = `${this.#cachePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(cacheFile), 'utf8');
      await fs.rename(tempPath, this.#cachePath);
    } catch {
      if (tempPath) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
      // Cache is an optimization only; never fail recent projects because it is unavailable.
    }
  }

  async #toCandidate(
    snapshot: CodexSessionProjectSnapshot,
    fsProvider?: ServiceContext['fsProvider']
  ): Promise<RecentProjectCandidate | null> {
    const identity = await this.deps.identityResolver.resolve(snapshot.cwd);
    const displayName = identity?.name ?? path.basename(snapshot.cwd) ?? snapshot.cwd;

    return {
      identity: identity?.id ?? `path:${normalizeIdentityPath(snapshot.cwd)}`,
      displayName,
      primaryPath: snapshot.cwd,
      associatedPaths: [snapshot.cwd],
      lastActivityAt: snapshot.lastActivityAt,
      providerIds: ['codex'],
      sourceKind: 'codex',
      openTarget: {
        type: 'synthetic-path',
        path: snapshot.cwd,
      },
      branchName: snapshot.branchName,
      filesystemState: await resolveProjectFilesystemState(snapshot.cwd, fsProvider),
    };
  }
}
