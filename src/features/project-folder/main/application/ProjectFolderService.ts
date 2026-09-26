import path from 'path';

import type {
  ProjectFolderCreateError,
  ProjectFolderCreateResult,
  ProjectFolderState,
  ProjectFolderStateResult,
} from '../../contracts';
import type { DirectoryPresence } from '@main/utils/directoryPresence';

export interface ProjectFolderFileSystem {
  readPresence(directoryPath: string): Promise<DirectoryPresence>;
  createDirectory(directoryPath: string): Promise<void>;
}

const STATE_BY_PRESENCE: Record<DirectoryPresence, ProjectFolderState> = {
  directory: 'exists',
  missing: 'missing',
  not_directory: 'not_directory',
  unknown: 'unknown',
};

/** Same shape the team create/launch validators accept: absolute and not a filesystem root. */
export function parseProjectFolderPath(input: unknown): string | null {
  const raw =
    typeof input === 'object' && input !== null ? (input as { path?: unknown }).path : undefined;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return null;
  const resolved = path.resolve(trimmed);
  return path.parse(resolved).root === resolved ? null : resolved;
}

function toCreateError(error: unknown): ProjectFolderCreateError {
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'permission_denied';
    case 'EEXIST':
    case 'ENOTDIR':
      return 'path_conflict';
    default:
      return 'failed';
  }
}

export class ProjectFolderService {
  constructor(private readonly fileSystem: ProjectFolderFileSystem) {}

  async getState(input: unknown): Promise<ProjectFolderStateResult> {
    const folderPath = parseProjectFolderPath(input);
    if (!folderPath) return { state: 'invalid' };
    return { state: STATE_BY_PRESENCE[await this.fileSystem.readPresence(folderPath)] };
  }

  async create(input: unknown): Promise<ProjectFolderCreateResult> {
    const folderPath = parseProjectFolderPath(input);
    if (!folderPath) return { state: 'invalid', error: 'invalid_path' };
    try {
      await this.fileSystem.createDirectory(folderPath);
    } catch (error) {
      const state = STATE_BY_PRESENCE[await this.fileSystem.readPresence(folderPath)];
      return { state, error: toCreateError(error) };
    }
    const state = STATE_BY_PRESENCE[await this.fileSystem.readPresence(folderPath)];
    return state === 'exists' ? { state } : { state, error: 'failed' };
  }
}
