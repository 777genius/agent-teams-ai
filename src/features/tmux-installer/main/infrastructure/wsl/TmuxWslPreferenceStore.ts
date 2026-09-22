import { mkdirSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { app } from 'electron';

interface PersistedTmuxWslPreference {
  preferredDistroName?: unknown;
}

type ResolveUserDataPath = () => string;

export class TmuxWslPreferenceStore {
  readonly #resolveUserDataPath: ResolveUserDataPath;

  constructor(resolveUserDataPath: ResolveUserDataPath = () => app.getPath('userData')) {
    this.#resolveUserDataPath = resolveUserDataPath;
  }

  async getPreferredDistro(): Promise<string | null> {
    try {
      const raw = await fsp.readFile(this.#getFilePath(), 'utf8');
      return this.#parsePreferredDistro(raw);
    } catch {
      return null;
    }
  }

  getPreferredDistroSync(): string | null {
    try {
      const raw = readFileSync(this.#getFilePath(), 'utf8');
      return this.#parsePreferredDistro(raw);
    } catch {
      return null;
    }
  }

  async setPreferredDistro(preferredDistroName: string): Promise<void> {
    const nextValue = preferredDistroName.trim();
    if (!nextValue) {
      await this.clearPreferredDistro();
      return;
    }

    const filePath = this.#getFilePath();
    await atomicWriteAsync(filePath, JSON.stringify({ preferredDistroName: nextValue }, null, 2));
  }

  async clearPreferredDistro(): Promise<void> {
    try {
      await fsp.unlink(this.#getFilePath());
    } catch {
      // ignore missing file
    }
  }

  #getFilePath(): string {
    const userDataPath = this.#resolveUserDataPath();
    const dirPath = path.join(userDataPath, 'tmux-installer');
    mkdirSync(dirPath, { recursive: true });
    return path.join(dirPath, 'wsl-preference.json');
  }

  #parsePreferredDistro(raw: string): string | null {
    try {
      const parsed = JSON.parse(raw) as PersistedTmuxWslPreference;
      return typeof parsed.preferredDistroName === 'string' && parsed.preferredDistroName.trim()
        ? parsed.preferredDistroName.trim()
        : null;
    } catch {
      return null;
    }
  }
}
