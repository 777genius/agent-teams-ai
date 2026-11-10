import { validateSnapshot } from '../../core/domain/folders';

import type { FolderRepository, LoadResult } from '../../core/application/folderController';
import type { Snapshot } from '../../core/domain/folders';
export const FOLDERS_STORAGE_KEY = 'taskFolders:v1';
export class BrowserFolderRepository implements FolderRepository {
  constructor(private storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage) {}
  async load(): Promise<LoadResult> {
    let raw: string | null;
    try {
      raw = this.storage().getItem(FOLDERS_STORAGE_KEY);
    } catch {
      return { kind: 'unavailable' };
    }
    if (raw === null) return { kind: 'empty' };
    try {
      return { kind: 'valid', snapshot: validateSnapshot(JSON.parse(raw)) };
    } catch (error) {
      return {
        kind:
          error instanceof Error && error.message === 'unsupported-version'
            ? 'unsupported-version'
            : 'corrupt',
      };
    }
  }
  async save(snapshot: Snapshot): Promise<void> {
    this.storage().setItem(FOLDERS_STORAGE_KEY, JSON.stringify(snapshot));
  }
}
