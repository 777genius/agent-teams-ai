import { atomicWriteAsync, renamePathWithRetry } from '@main/utils/atomicWrite';
import { mkdir, readdir, readFile, rm, stat } from 'fs/promises';
import path from 'path';

import { isRuntimeTurnSettledProvider } from '../../core/domain';

import type {
  RuntimeTurnSettledClaimedPayload,
  RuntimeTurnSettledEventStorePort,
  RuntimeTurnSettledInvalidResult,
  RuntimeTurnSettledProcessedResult,
} from '../../core/application';
import type { RuntimeTurnSettledProvider } from '../../core/domain';
import type { RuntimeTurnSettledSpoolPaths } from './RuntimeTurnSettledSpoolPaths';

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_PROCESSED_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROCESSED_RETENTION_COUNT = 1000;
const DEFAULT_PROCESSING_STALE_MS = 5 * 60 * 1000;

export interface FileRuntimeTurnSettledEventStoreDeps {
  paths: RuntimeTurnSettledSpoolPaths;
  maxPayloadBytes?: number;
  processedRetentionMs?: number;
  processedRetentionCount?: number;
  processingStaleMs?: number;
  now?: () => Date;
}

function parseProviderFromFileName(fileName: string): RuntimeTurnSettledProvider | null {
  const parts = fileName.split('.');
  const provider = parts.length >= 3 ? parts[parts.length - 2] : null;
  return isRuntimeTurnSettledProvider(provider) ? provider : null;
}

function buildMetaFilePath(filePath: string): string {
  return `${filePath}.meta.json`;
}

async function moveFileBestEffort(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await renamePathWithRetry(sourcePath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export class FileRuntimeTurnSettledEventStore implements RuntimeTurnSettledEventStorePort {
  private readonly maxPayloadBytes: number;
  private readonly processedRetentionMs: number;
  private readonly processedRetentionCount: number;
  private readonly processingStaleMs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: FileRuntimeTurnSettledEventStoreDeps) {
    this.maxPayloadBytes = deps.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.processedRetentionMs = deps.processedRetentionMs ?? DEFAULT_PROCESSED_RETENTION_MS;
    this.processedRetentionCount =
      deps.processedRetentionCount ?? DEFAULT_PROCESSED_RETENTION_COUNT;
    this.processingStaleMs = deps.processingStaleMs ?? DEFAULT_PROCESSING_STALE_MS;
    this.now = deps.now ?? (() => new Date());
  }

  async claimPending(limit: number): Promise<RuntimeTurnSettledClaimedPayload[]> {
    await this.ensureDirectories();
    await this.recoverStaleProcessingPayloads();

    const entries = await readdir(this.deps.paths.getIncomingDir(), { withFileTypes: true }).catch(
      () => []
    );
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((fileName) => !fileName.startsWith('.'))
      .sort()
      .slice(0, Math.max(0, limit));

    const claimed: RuntimeTurnSettledClaimedPayload[] = [];
    for (const fileName of files) {
      const provider = parseProviderFromFileName(fileName);
      const incomingPath = path.join(this.deps.paths.getIncomingDir(), fileName);
      if (!provider) {
        await this.quarantineIncoming(incomingPath, fileName, 'unsupported_provider');
        continue;
      }

      const processingPath = path.join(this.deps.paths.getProcessingDir(), fileName);
      try {
        await renamePathWithRetry(incomingPath, processingPath);
      } catch {
        continue;
      }

      const fileStat = await stat(processingPath).catch(() => null);
      const payloadTooLarge = Boolean(fileStat?.isFile() && fileStat.size > this.maxPayloadBytes);
      if (!fileStat?.isFile() || payloadTooLarge) {
        await this.markInvalid(
          {
            id: fileName,
            filePath: processingPath,
            fileName,
            provider,
            raw: '',
            claimedAt: this.now().toISOString(),
          },
          {
            reason: payloadTooLarge ? 'payload_too_large' : 'payload_missing',
            processedAt: this.now().toISOString(),
          }
        );
        continue;
      }

      const raw = await readFile(processingPath, 'utf8').catch(() => '');
      claimed.push({
        id: fileName,
        filePath: processingPath,
        fileName,
        provider,
        raw,
        claimedAt: this.now().toISOString(),
      });
    }

    return claimed;
  }

  async markProcessed(
    payload: RuntimeTurnSettledClaimedPayload,
    result: RuntimeTurnSettledProcessedResult
  ): Promise<void> {
    const processedPath = path.join(this.deps.paths.getProcessedDir(), payload.fileName);
    await moveFileBestEffort(payload.filePath, processedPath);
    await atomicWriteAsync(
      buildMetaFilePath(processedPath),
      `${JSON.stringify(result, null, 2)}\n`
    );
    await this.cleanupDirectory(this.deps.paths.getProcessedDir());
  }

  async markInvalid(
    payload: RuntimeTurnSettledClaimedPayload,
    result: RuntimeTurnSettledInvalidResult
  ): Promise<void> {
    const invalidPath = path.join(this.deps.paths.getInvalidDir(), payload.fileName);
    await moveFileBestEffort(payload.filePath, invalidPath);
    await atomicWriteAsync(buildMetaFilePath(invalidPath), `${JSON.stringify(result, null, 2)}\n`);
    await this.cleanupDirectory(this.deps.paths.getInvalidDir());
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.deps.paths.getIncomingDir(), { recursive: true }),
      mkdir(this.deps.paths.getProcessingDir(), { recursive: true }),
      mkdir(this.deps.paths.getProcessedDir(), { recursive: true }),
      mkdir(this.deps.paths.getInvalidDir(), { recursive: true }),
    ]);
  }

  private async recoverStaleProcessingPayloads(): Promise<void> {
    const cutoff = this.now().getTime() - this.processingStaleMs;
    const entries = await readdir(this.deps.paths.getProcessingDir(), {
      withFileTypes: true,
    }).catch(() => []);

    await Promise.allSettled(
      entries
        .filter(
          (entry) =>
            entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.meta.json')
        )
        .map(async (entry) => {
          const processingPath = path.join(this.deps.paths.getProcessingDir(), entry.name);
          const fileStat = await stat(processingPath).catch(() => null);
          if (!fileStat?.isFile() || fileStat.mtimeMs > cutoff) {
            return;
          }

          await moveFileBestEffort(
            processingPath,
            path.join(this.deps.paths.getIncomingDir(), entry.name)
          );
        })
    );
  }

  private async quarantineIncoming(
    incomingPath: string,
    fileName: string,
    reason: string
  ): Promise<void> {
    const invalidPath = path.join(this.deps.paths.getInvalidDir(), fileName);
    await moveFileBestEffort(incomingPath, invalidPath);
    await atomicWriteAsync(
      buildMetaFilePath(invalidPath),
      `${JSON.stringify({ reason, processedAt: this.now().toISOString() }, null, 2)}\n`
    );
  }

  private async cleanupDirectory(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = (
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && !entry.name.endsWith('.meta.json'))
          .map(async (entry) => {
            const filePath = path.join(directory, entry.name);
            const fileStat = await stat(filePath).catch(() => null);
            return fileStat?.isFile() ? { filePath, mtimeMs: fileStat.mtimeMs } : null;
          })
      )
    )
      .filter((entry): entry is { filePath: string; mtimeMs: number } => Boolean(entry))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    const cutoff = this.now().getTime() - this.processedRetentionMs;
    const toRemove = files.filter(
      (file, index) => index >= this.processedRetentionCount || file.mtimeMs < cutoff
    );

    await Promise.allSettled(
      toRemove.flatMap((file) => [
        rm(file.filePath, { force: true }),
        rm(buildMetaFilePath(file.filePath), { force: true }),
      ])
    );
  }
}
