/**
 * SshFileSystemProvider - FileSystemProvider backed by SSH2 SFTP.
 *
 * Wraps an ssh2 SFTPWrapper to provide the same filesystem interface
 * used by session-data services, enabling remote file access.
 */

import { createLogger } from '@shared/utils/logger';
import { PassThrough, type Readable } from 'stream';

import type {
  FileSystemProvider,
  FsDirent,
  FsStatResult,
  ReadStreamOptions,
} from './FileSystemProvider';
import type { SFTPWrapper } from 'ssh2';

const logger = createLogger('Infrastructure:SshFileSystemProvider');

export type SftpErrorKind = 'not_found' | 'transient' | 'permanent';

export class SshFileSystemProvider implements FileSystemProvider {
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_BASE_DELAY_MS = 75;

  readonly type = 'ssh' as const;
  private sftp: SFTPWrapper;

  constructor(sftp: SFTPWrapper) {
    this.sftp = sftp;
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch (error) {
      const errorKind = this.classifySftpError(error);
      if (errorKind === 'not_found') {
        return false;
      }

      // For transient SFTP failures (e.g. code=4), avoid false negatives.
      if (errorKind === 'transient') {
        const code = this.getErrorCode(error);
        logger.debug(
          `exists(${filePath}) got retryable SFTP error (${String(code)}); treating path as potentially present`
        );
        return true;
      }

      return false;
    }
  }

  async readFile(filePath: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SshFileSystemProvider.MAX_RETRIES; attempt++) {
      try {
        return await new Promise<string>((resolve, reject) => {
          this.sftp.readFile(filePath, { encoding }, (err, data) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(data as unknown as string);
          });
        });
      } catch (error) {
        lastError = error;
        if (
          this.classifySftpError(error) === 'transient' &&
          attempt < SshFileSystemProvider.MAX_RETRIES
        ) {
          await this.sleep(SshFileSystemProvider.RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to read file: ${filePath}`);
  }

  async stat(filePath: string): Promise<FsStatResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SshFileSystemProvider.MAX_RETRIES; attempt++) {
      try {
        return await new Promise<FsStatResult>((resolve, reject) => {
          this.sftp.stat(filePath, (err, stats) => {
            if (err) {
              reject(err);
              return;
            }
            // SFTP stats use mode bitmask for file type detection
            const S_IFMT = 0o170000;
            const S_IFREG = 0o100000;
            const S_IFDIR = 0o040000;
            const mode = stats.mode;

            resolve({
              size: stats.size,
              mtimeMs: (stats.mtime ?? 0) * 1000,
              // SFTP doesn't provide birth time, use mtime as fallback
              birthtimeMs: (stats.mtime ?? 0) * 1000,
              isFile: () => (mode & S_IFMT) === S_IFREG,
              isDirectory: () => (mode & S_IFMT) === S_IFDIR,
            });
          });
        });
      } catch (error) {
        lastError = error;
        if (
          this.classifySftpError(error) === 'transient' &&
          attempt < SshFileSystemProvider.MAX_RETRIES
        ) {
          await this.sleep(SshFileSystemProvider.RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to stat: ${filePath}`);
  }

  async readdir(dirPath: string): Promise<FsDirent[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SshFileSystemProvider.MAX_RETRIES; attempt++) {
      try {
        return await new Promise<FsDirent[]>((resolve, reject) => {
          this.sftp.readdir(dirPath, (err, list) => {
            if (err) {
              reject(err);
              return;
            }
            const S_IFMT = 0o170000;
            const S_IFREG = 0o100000;
            const S_IFDIR = 0o040000;

            const entries: FsDirent[] = [];
            for (const item of list) {
              const mode = item.attrs.mode;
              entries.push(
                this.buildDirent(
                  item.filename,
                  mode,
                  S_IFMT,
                  S_IFREG,
                  S_IFDIR,
                  item.attrs.size,
                  item.attrs.mtime
                )
              );
            }
            resolve(entries);
          });
        });
      } catch (error) {
        lastError = error;
        if (
          this.classifySftpError(error) === 'transient' &&
          attempt < SshFileSystemProvider.MAX_RETRIES
        ) {
          await this.sleep(SshFileSystemProvider.RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to read directory: ${dirPath}`);
  }

  createReadStream(filePath: string, opts?: ReadStreamOptions): Readable {
    try {
      const sftpStream = this.sftp.createReadStream(filePath, {
        start: opts?.start,
        encoding: opts?.encoding ?? undefined,
      });

      // Wrap in PassThrough to ensure Node Readable compatibility
      const passthrough = new PassThrough();
      sftpStream.pipe(passthrough);
      sftpStream.on('error', (err: Error) => {
        passthrough.destroy(err);
      });

      return passthrough;
    } catch (err) {
      logger.error(`Error creating read stream for ${filePath}:`, err);
      // Return an errored stream
      const errStream = new PassThrough();
      process.nextTick(() => errStream.destroy(err as Error));
      return errStream;
    }
  }

  dispose(): void {
    try {
      this.sftp.end();
    } catch {
      // Ignore errors during cleanup
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private getErrorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'number') {
        return String(code);
      }
      if (typeof code === 'string') {
        return code;
      }
    }
    return '';
  }

  private isNotFoundError(error: unknown): boolean {
    const code = this.getErrorCode(error);
    return code === '2' || code === 'ENOENT';
  }

  private isRetryableError(error: unknown): boolean {
    const code = this.getErrorCode(error);
    return (
      code === '4' ||
      code === 'EAGAIN' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'EPIPE'
    );
  }

  private classifySftpError(error: unknown): SftpErrorKind {
    if (this.isNotFoundError(error)) {
      return 'not_found';
    }
    if (this.isRetryableError(error)) {
      return 'transient';
    }
    return 'permanent';
  }

  private buildDirent(
    filename: string,
    mode: number,
    sifmt: number,
    sifreg: number,
    sifdir: number,
    size?: number,
    mtimeSeconds?: number
  ): FsDirent {
    const mtimeMs = typeof mtimeSeconds === 'number' ? mtimeSeconds * 1000 : undefined;
    return {
      name: filename,
      isFile: () => (mode & sifmt) === sifreg,
      isDirectory: () => (mode & sifmt) === sifdir,
      size,
      mtimeMs,
      birthtimeMs: mtimeMs,
    };
  }
}
