import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { addLogSink, type LogSinkEntry } from '@shared/utils/logger';
import { redactSentryEvent } from '@shared/utils/sentryConfig';

const LOG_FILE_NAME = 'app-errors.ndjson';
const ROTATED_LOG_FILE_NAME = 'app-errors.1.ndjson';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_PENDING_ENTRIES = 500;
const MAX_MESSAGE_CHARS = 12_000;

export interface PersistentAppLogOptions {
  directory: string;
  appVersion: string;
  platform?: NodeJS.Platform;
  maxBytes?: number;
  maxPendingEntries?: number;
}

export interface PersistentAppLogHandle {
  filePath: string;
  rotatedFilePath: string;
  flush(): Promise<void>;
  dispose(): void;
}

interface PersistentLogRecord {
  v: 1;
  t: string;
  level: 'warn' | 'error';
  process: 'main' | 'renderer';
  namespace: string;
  appVersion: string;
  platform: NodeJS.Platform;
  message: string;
}

function normalizeError(error: Error): Record<string, unknown> {
  const candidate = error as Error & {
    code?: unknown;
    category?: unknown;
    cause?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(candidate.code !== undefined ? { code: candidate.code } : {}),
    ...(candidate.category !== undefined ? { category: candidate.category } : {}),
    ...(candidate.cause !== undefined ? { cause: candidate.cause } : {}),
  };
}

function stringifyLogValue(value: unknown): string {
  const normalized = value instanceof Error ? normalizeError(value) : value;
  const redacted = redactSentryEvent(normalized);
  if (typeof redacted === 'string') {
    return redacted;
  }
  try {
    const serialized = JSON.stringify(redacted);
    return serialized ?? String(redacted);
  } catch {
    return '[unserializable]';
  }
}

export function formatPersistentLogMessage(args: readonly unknown[]): string {
  const message = args.map(stringifyLogValue).join(' ').trim();
  if (message.length <= MAX_MESSAGE_CHARS) {
    return message;
  }
  return `${message.slice(0, MAX_MESSAGE_CHARS)}...[truncated]`;
}

function buildRecord(
  entry: LogSinkEntry,
  appVersion: string,
  platform: NodeJS.Platform
): PersistentLogRecord {
  return {
    v: 1,
    t: entry.timestamp,
    level: entry.level,
    process: entry.namespace === 'Renderer' ? 'renderer' : 'main',
    namespace: stringifyLogValue(entry.namespace),
    appVersion,
    platform,
    message: formatPersistentLogMessage(entry.args),
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function installPersistentAppLog(options: PersistentAppLogOptions): PersistentAppLogHandle {
  const filePath = join(options.directory, LOG_FILE_NAME);
  const rotatedFilePath = join(options.directory, ROTATED_LOG_FILE_NAME);
  const maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxPendingEntries = Math.max(10, options.maxPendingEntries ?? DEFAULT_MAX_PENDING_ENTRIES);
  const platform = options.platform ?? process.platform;
  const pending: PersistentLogRecord[] = [];
  const directoryReady = mkdir(options.directory, { recursive: true }).then(
    () => true,
    () => false
  );
  let droppedEntries = 0;
  let drainPromise: Promise<void> | null = null;
  let disposed = false;

  const rotateIfNeeded = async (incomingBytes: number): Promise<void> => {
    let currentBytes = 0;
    try {
      currentBytes = (await stat(filePath)).size;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    if (currentBytes + incomingBytes <= maxBytes) return;

    await rm(rotatedFilePath, { force: true });
    try {
      await rename(filePath, rotatedFilePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  };

  const writeEntry = async (record: PersistentLogRecord): Promise<void> => {
    const line = `${JSON.stringify(record)}\n`;
    if (!(await directoryReady)) return;
    await rotateIfNeeded(Buffer.byteLength(line));
    await appendFile(filePath, line, 'utf8');
  };

  const scheduleDrain = (): void => {
    if (drainPromise || pending.length === 0) return;
    drainPromise = (async () => {
      while (pending.length > 0) {
        if (droppedEntries > 0) {
          const dropped = droppedEntries;
          droppedEntries = 0;
          try {
            await writeEntry(
              buildRecord(
                {
                  timestamp: new Date().toISOString(),
                  level: 'warn',
                  namespace: 'PersistentAppLog',
                  args: [`Dropped ${dropped} log entries because the write queue was full`],
                },
                options.appVersion,
                platform
              )
            );
          } catch {
            // Diagnostics must not alter application behavior.
          }
        }

        const entry = pending.shift();
        if (!entry) continue;
        try {
          await writeEntry(entry);
        } catch {
          // A read-only or full disk must not create a logging failure loop.
        }
      }
    })().finally(() => {
      drainPromise = null;
      if (pending.length > 0) scheduleDrain();
    });
  };

  const removeSink = addLogSink((entry) => {
    if (disposed) return;
    if (pending.length >= maxPendingEntries) {
      droppedEntries += 1;
      return;
    }
    pending.push(buildRecord(entry, options.appVersion, platform));
    scheduleDrain();
  });

  return {
    filePath,
    rotatedFilePath,
    async flush(): Promise<void> {
      while (drainPromise || pending.length > 0) {
        scheduleDrain();
        await drainPromise;
      }
    },
    dispose(): void {
      disposed = true;
      removeSink();
    },
  };
}
