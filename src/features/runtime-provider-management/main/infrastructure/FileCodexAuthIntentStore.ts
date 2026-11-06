import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { withFileLock } from '@main/services/team/fileLock';
import { atomicCreateAsync } from '@main/utils/atomicWrite';

export interface CodexAuthIntent {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly targetId: string;
  readonly kind: 'credential.forget' | 'credential.refresh';
}
export interface CodexAuthIntentStore {
  read(targetId: string): Promise<CodexAuthIntent | null>;
  create(intent: CodexAuthIntent): Promise<boolean>;
  retire(intent: CodexAuthIntent): Promise<void>;
}
const failure = () => new Error('The original Codex account operation could not be confirmed.');
const targetIdValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function capture(value: unknown): CodexAuthIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    !targetIdValid(row.targetId) ||
    typeof row.commandId !== 'string' ||
    !/^codex-auth-[a-f0-9-]{36}$/.test(row.commandId) ||
    !['credential.forget', 'credential.refresh'].includes(String(row.kind)) ||
    Object.keys(row).some(
      (key) => !['schemaVersion', 'commandId', 'targetId', 'kind'].includes(key)
    )
  )
    throw failure();
  return Object.freeze({ ...row }) as unknown as CodexAuthIntent;
}

/** Private original routing only. No account data, credentials or native paths are journaled. */
export class FileCodexAuthIntentStore implements CodexAuthIntentStore {
  private identity?: { dev: number; ino: number };
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory) || resolve(directory) !== directory || directory.includes('\0'))
      throw failure();
  }
  private path(targetId: string): string {
    if (!targetIdValid(targetId)) throw failure();
    return join(this.directory, targetId + '.json');
  }
  private async check(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (await realpath(this.directory)) !== this.directory
    )
      throw failure();
    if (this.identity && (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino))
      throw failure();
    this.identity ??= { dev: stat.dev, ino: stat.ino };
  }
  private async safe<T>(body: () => Promise<T>): Promise<T> {
    try {
      await this.check();
      return await body();
    } catch {
      throw failure();
    }
  }
  private async readValue(targetId: string): Promise<CodexAuthIntent | null> {
    try {
      const file = await open(
        this.path(targetId),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      );
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > 4096 || (before.mode & 0o077) !== 0) throw failure();
        const bytes = Buffer.alloc(4097);
        let size = 0;
        while (size < bytes.length) {
          const result = await file.read(bytes, size, bytes.length - size, null);
          if (!result.bytesRead) break;
          size += result.bytesRead;
        }
        const after = await file.stat();
        if (size > 4096 || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          throw failure();
        const value = capture(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
        );
        if (value.targetId !== targetId) throw failure();
        await this.check();
        return value;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  read(targetId: string): Promise<CodexAuthIntent | null> {
    return this.safe(() => this.readValue(targetId));
  }
  create(input: CodexAuthIntent): Promise<boolean> {
    const intent = capture(input);
    return this.safe(() =>
      withFileLock(
        this.path(intent.targetId),
        async () => {
          await this.check();
          if (await this.readValue(intent.targetId)) return false;
          await atomicCreateAsync(this.path(intent.targetId), JSON.stringify(intent) + '\n', {
            mode: 0o600,
          });
          await this.check();
          return true;
        },
        { preventLiveOwnerTakeover: true }
      )
    );
  }
  retire(input: CodexAuthIntent): Promise<void> {
    const intent = capture(input);
    return this.safe(() =>
      withFileLock(
        this.path(intent.targetId),
        async () => {
          await this.check();
          const saved = await this.readValue(intent.targetId);
          if (!saved) return;
          if (saved.commandId !== intent.commandId || saved.kind !== intent.kind) throw failure();
          await unlink(this.path(intent.targetId));
          await this.check();
        },
        { preventLiveOwnerTakeover: true }
      )
    );
  }
}
