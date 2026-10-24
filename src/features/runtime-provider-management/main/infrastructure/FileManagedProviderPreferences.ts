import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { withFileLock } from '@main/services/team/fileLock';
import { atomicWriteAsync } from '@main/utils/atomicWrite';

import {
  emptyManagedPreferences,
  parseManagedPreferences,
  validManagedModelId,
  validManagedModelLimits,
} from '../../core/domain/managedProviderPreferences';

import type { ManagedProviderPreferences } from '../../core/domain/managedProviderPreferences';

export interface ManagedPreferencePaths {
  readonly projectRoot: string | null;
  /** Directory containing the frozen global-runtime-preferences.json, not a derived ambient HOME. */
  readonly globalRoot: string;
}
interface Snapshot {
  value: ManagedProviderPreferences;
  identity: string | null;
  mode: number;
}
const failure = () => new Error('Unable to confirm the selected model preferences');

/** Uses existing preference filenames, atomic publication and the app's PID-aware file lock. */
export class FileManagedProviderPreferences {
  private readonly roots = new Map<string, { dev: number; ino: number }>();
  private constructor(
    private readonly paths: ManagedPreferencePaths,
    private readonly isCurrent: () => boolean
  ) {}

  static async capture(
    paths: ManagedPreferencePaths,
    isCurrent: () => boolean
  ): Promise<FileManagedProviderPreferences> {
    const captured = Object.freeze({ ...paths });
    const store = new FileManagedProviderPreferences(captured, isCurrent);
    for (const path of [captured.projectRoot, captured.globalRoot]) {
      if (path === null || store.roots.has(path)) continue;
      if (
        !isAbsolute(path) ||
        resolve(path) !== path ||
        path.includes('\0') ||
        (await realpath(path)) !== path
      )
        throw failure();
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
      store.roots.set(path, { dev: stat.dev, ino: stat.ino });
    }
    await store.check();
    return store;
  }

  private async check(): Promise<void> {
    if (!this.isCurrent()) throw failure();
    for (const [path, identity] of this.roots) {
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino ||
        (await realpath(path)) !== path
      )
        throw failure();
    }
    if (!this.isCurrent()) throw failure();
  }
  private path(scope: 'project' | 'all_projects'): string {
    const root = scope === 'project' ? this.paths.projectRoot : this.paths.globalRoot;
    if (!root) throw failure();
    return join(
      root,
      scope === 'project'
        ? 'agent-teams-runtime-preferences.json'
        : 'global-runtime-preferences.json'
    );
  }
  private async readFile(path: string): Promise<Snapshot> {
    await this.check();
    try {
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o022) !== 0) throw failure();
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await file.stat();
        if (length > 1024 * 1024 || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
          throw failure();
        const bytes = buffer.subarray(0, length);
        const value = parseManagedPreferences(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        );
        await this.check();
        return {
          value,
          identity: `${stat.dev}:${stat.ino}:${stat.mode}:${createHash('sha256').update(bytes).digest('hex')}`,
          mode: stat.mode & 0o777,
        };
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.check();
        return { value: emptyManagedPreferences(), identity: null, mode: 0o600 };
      }
      throw failure();
    }
  }

  async read(): Promise<{
    project: ManagedProviderPreferences | null;
    global: ManagedProviderPreferences;
  }> {
    const global = (await this.readFile(this.path('all_projects'))).value;
    const project = this.paths.projectRoot
      ? (await this.readFile(this.path('project'))).value
      : null;
    return { project, global };
  }

  async setDefault(scope: 'project' | 'all_projects', modelId: string | null): Promise<void> {
    if (modelId !== null && !validManagedModelId(modelId)) throw failure();
    return this.update(scope, (before) => ({ ...before, defaultModelId: modelId }));
  }

  async setLimits(modelId: string, contextTokens: number, outputTokens: number): Promise<void> {
    if (!validManagedModelId(modelId) || !validManagedModelLimits(contextTokens, outputTokens))
      throw failure();
    return this.update('project', (before) => ({
      ...before,
      modelLimitOverrides: {
        ...before.modelLimitOverrides,
        [modelId]: {
          ...before.modelLimitOverrides[modelId],
          contextTokens,
          outputTokens,
          updatedAt: new Date().toISOString(),
        },
      },
    }));
  }

  private async update(
    scope: 'project' | 'all_projects',
    change: (before: ManagedProviderPreferences) => ManagedProviderPreferences
  ): Promise<void> {
    const path = this.path(scope);
    await this.check();
    await withFileLock(
      path,
      async () => {
        const before = await this.readFile(path);
        const next = {
          ...change(before.value),
          updatedAt: new Date().toISOString(),
        };
        const bytes = JSON.stringify(next, null, 2) + '\n';
        if (Buffer.byteLength(bytes) > 1024 * 1024) throw failure();
        await atomicWriteAsync(path, bytes, {
          mode: before.mode,
          beforeCommit: async () => {
            await this.check();
            if ((await this.readFile(path)).identity !== before.identity) throw failure();
          },
        });
        await this.check();
      },
      { preventLiveOwnerTakeover: true }
    );
  }
}
