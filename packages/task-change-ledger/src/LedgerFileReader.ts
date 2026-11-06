import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import {
  TASK_CHANGE_LEDGER_DIRNAME,
  TASK_CHANGE_LEDGER_READ_LIMITS,
  isPathWithinLedgerRoot,
} from './artifactPaths.js';
import type { LedgerContentRef } from './ledgerTypes.js';
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';

function decodeLedgerTextBlob(buffer: Buffer): string | null {
  for (const byte of buffer) {
    if (byte === 0 || byte < 9 || (byte > 13 && byte < 32)) {
      return null;
    }
  }
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer) ? text : null;
}

export class LedgerFileReader {
  private activeBlobReads = 0;
  private readonly pendingBlobReads: (() => void)[] = [];

  private async withBlobReadPermit<T>(read: () => Promise<T>): Promise<T> {
    if (this.activeBlobReads >= TASK_CHANGE_LEDGER_READ_LIMITS.blobConcurrency) {
      await new Promise<void>((resolve) => this.pendingBlobReads.push(resolve));
    } else {
      this.activeBlobReads++;
    }
    try {
      return await read();
    } finally {
      const next = this.pendingBlobReads.shift();
      if (next) {
        next();
      } else {
        this.activeBlobReads--;
      }
    }
  }

  async resolveConfinedLedgerFile(
    projectDir: string,
    filePath: string,
    containmentRoot = projectDir
  ): Promise<string | null> {
    try {
      const lexicalProjectRoot = path.resolve(path.normalize(projectDir));
      const lexicalContainmentRoot = path.resolve(path.normalize(containmentRoot));
      const lexicalFilePath = path.resolve(path.normalize(filePath));
      if (
        !isPathWithinLedgerRoot(lexicalContainmentRoot, lexicalProjectRoot) ||
        !isPathWithinLedgerRoot(lexicalFilePath, lexicalContainmentRoot)
      ) {
        return null;
      }

      const containmentStat = await stat(lexicalContainmentRoot);
      if (!containmentStat.isDirectory()) {
        return null;
      }
      const [realProjectRoot, realContainmentRoot, realFilePath] = await Promise.all([
        realpath(lexicalProjectRoot),
        realpath(lexicalContainmentRoot),
        realpath(lexicalFilePath),
      ]);
      if (
        !isPathWithinLedgerRoot(realContainmentRoot, realProjectRoot) ||
        !isPathWithinLedgerRoot(realFilePath, realContainmentRoot)
      ) {
        return null;
      }
      return realFilePath;
    } catch {
      return null;
    }
  }

  async readConfinedLedgerFile(
    projectDir: string,
    filePath: string,
    maxBytes: number,
    containmentRoot = projectDir
  ): Promise<Buffer | null> {
    const realFilePath = await this.resolveConfinedLedgerFile(
      projectDir,
      filePath,
      containmentRoot
    );
    if (!realFilePath) {
      return null;
    }

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      try {
        handle = await open(realFilePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) {
          throw error;
        }
        const revalidatedPath = await this.resolveConfinedLedgerFile(
          projectDir,
          filePath,
          containmentRoot
        );
        if (revalidatedPath !== realFilePath) {
          return null;
        }
        handle = await open(realFilePath, fsConstants.O_RDONLY);
      }
      const revalidatedPath = await this.resolveConfinedLedgerFile(
        projectDir,
        filePath,
        containmentRoot
      );
      if (revalidatedPath !== realFilePath) {
        return null;
      }
      const initialStat = await handle.stat();
      if (
        !initialStat.isFile() ||
        !Number.isSafeInteger(initialStat.size) ||
        initialStat.size < 0 ||
        initialStat.size > maxBytes
      ) {
        return null;
      }

      const buffer = Buffer.alloc(initialStat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) {
          return null;
        }
        offset += bytesRead;
      }
      const finalStat = await handle.stat();
      if (
        finalStat.size !== initialStat.size ||
        finalStat.mtimeMs !== initialStat.mtimeMs ||
        finalStat.ctimeMs !== initialStat.ctimeMs
      ) {
        return null;
      }
      return buffer;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async readContentRef(projectDir: string, ref: LedgerContentRef | null): Promise<string | null> {
    if (!ref?.blobRef) {
      return null;
    }
    try {
      if (
        typeof ref.blobRef !== 'string' ||
        !ref.blobRef.trim() ||
        path.isAbsolute(ref.blobRef) ||
        typeof ref.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(ref.sha256) ||
        !Number.isSafeInteger(ref.sizeBytes) ||
        ref.sizeBytes < 0 ||
        ref.sizeBytes > TASK_CHANGE_LEDGER_READ_LIMITS.blobBytes
      ) {
        return null;
      }

      const blobsRoot = path.resolve(projectDir, TASK_CHANGE_LEDGER_DIRNAME, 'blobs');
      const blobPath = path.resolve(blobsRoot, ref.blobRef);
      if (!isPathWithinLedgerRoot(blobPath, blobsRoot)) {
        return null;
      }

      const buffer = await this.withBlobReadPermit(() =>
        this.readConfinedLedgerFile(
          projectDir,
          blobPath,
          TASK_CHANGE_LEDGER_READ_LIMITS.blobBytes,
          blobsRoot
        )
      );
      if (
        !buffer ||
        buffer.byteLength !== ref.sizeBytes ||
        createHash('sha256').update(buffer).digest('hex') !== ref.sha256.toLowerCase()
      ) {
        return null;
      }
      return decodeLedgerTextBlob(buffer);
    } catch {
      return null;
    }
  }
}
