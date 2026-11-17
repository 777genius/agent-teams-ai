import { atomicWriteAsync } from '@main/utils/atomicWrite';
import {
  claimTeamForThisProfile,
  readTeamOwnerProfileScope,
  resolveThisAppProfileScope,
} from '@main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { withFileLock } from '@main/services/team/fileLock';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const INDEX_FILE = 'project-contexts.json';
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_PROJECT_CONTEXTS = 128;
const TEAM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface PersistedTeamWorkContext {
  id: string;
  /** Canonical project identity as observed when the context was created. */
  projectKey: string;
  projectPath: string;
  /** Native CLI-visible team name. Never accept this value from an IPC caller. */
  executionTeamName: string;
  state: 'reserved' | 'ready';
}

interface TeamProjectContextIndex {
  version: 1;
  logicalTeamName: string;
  contexts: PersistedTeamWorkContext[];
}

export interface TeamProjectContextRegistryPaths {
  teamsBasePath: string;
  tasksBasePath: string;
  profileScope: string;
}

export class TeamProjectContextUnavailableError extends Error {
  readonly code = 'TEAM_PROJECT_CONTEXT_UNAVAILABLE';
}

function checkedTeamName(teamName: string): string {
  if (!TEAM_NAME.test(teamName) || teamName.length > 64) {
    throw new TeamProjectContextUnavailableError('Invalid team identifier');
  }
  return teamName;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Only absolute, existing project directories qualify for a new context.
 * This is an identity key, not a filesystem access authorization.
 */
async function canonicalProjectPath(value: string): Promise<string> {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TeamProjectContextUnavailableError('Choose an absolute project folder');
  }
  const canonical = await fs.realpath(value);
  if (!(await fs.stat(canonical)).isDirectory()) {
    throw new TeamProjectContextUnavailableError('Project path is not a directory');
  }
  return process.platform === 'win32' ? path.normalize(canonical).toLowerCase() : canonical;
}

function validateIndex(value: unknown, logicalTeamName: string): TeamProjectContextIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamProjectContextUnavailableError('Invalid project-context index');
  }
  const source = value as Record<string, unknown>;
  if (
    source.version !== 1 ||
    source.logicalTeamName !== logicalTeamName ||
    !Array.isArray(source.contexts) ||
    source.contexts.length > MAX_PROJECT_CONTEXTS
  ) {
    throw new TeamProjectContextUnavailableError('Incompatible project-context index');
  }
  const projectKeys = new Set<string>();
  const executionNames = new Set<string>();
  const contexts: PersistedTeamWorkContext[] = [];
  for (const item of source.contexts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TeamProjectContextUnavailableError('Invalid project-context entry');
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(row.id) ||
      typeof row.projectKey !== 'string' ||
      !path.isAbsolute(row.projectKey) ||
      typeof row.projectPath !== 'string' ||
      !path.isAbsolute(row.projectPath) ||
      typeof row.executionTeamName !== 'string' ||
      !TEAM_NAME.test(row.executionTeamName) ||
      row.executionTeamName.length > 64 ||
      row.executionTeamName === logicalTeamName ||
      (row.state !== 'reserved' && row.state !== 'ready') ||
      projectKeys.has(row.projectKey) ||
      executionNames.has(row.executionTeamName)
    ) {
      throw new TeamProjectContextUnavailableError('Invalid or duplicate project-context entry');
    }
    projectKeys.add(row.projectKey);
    executionNames.add(row.executionTeamName);
    contexts.push(row as unknown as PersistedTeamWorkContext);
  }
  return { version: 1, logicalTeamName, contexts };
}

/**
 * Small app-owned index. Physical context folders remain in the native CLI's
 * canonical teams/tasks roots; this class does not rewrite those storage APIs.
 * All public methods require a proven app-profile-owned logical team.
 */
export class TeamProjectContextRegistry {
  constructor(private readonly paths: TeamProjectContextRegistryPaths) {}

  static fromCurrentApp(): TeamProjectContextRegistry {
    // Imported lazily to keep test fixtures independent from the real user HOME.
    const { getTeamsBasePath, getTasksBasePath } =
      require('@main/utils/pathDecoder') as typeof import('@main/utils/pathDecoder');
    return new TeamProjectContextRegistry({
      teamsBasePath: getTeamsBasePath(),
      tasksBasePath: getTasksBasePath(),
      profileScope: resolveThisAppProfileScope(),
    });
  }

  private async assertOwnedDirectory(name: string): Promise<void> {
    const teamName = checkedTeamName(name);
    const teamDir = path.join(this.paths.teamsBasePath, teamName);
    const stat = await fs.lstat(teamDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TeamProjectContextUnavailableError('Team storage is not a regular directory');
    }
    const owner = await readTeamOwnerProfileScope(teamDir);
    if (owner !== this.paths.profileScope) {
      throw new TeamProjectContextUnavailableError('Team belongs to a different or unknown profile');
    }
  }

  private indexPath(logicalTeamName: string): string {
    return path.join(this.paths.teamsBasePath, checkedTeamName(logicalTeamName), INDEX_FILE);
  }

  private async readIndex(logicalTeamName: string): Promise<TeamProjectContextIndex> {
    const target = this.indexPath(logicalTeamName);
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, logicalTeamName, contexts: [] };
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INDEX_BYTES) {
      throw new TeamProjectContextUnavailableError('Unsafe project-context index');
    }
    const content = await fs.readFile(target, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_INDEX_BYTES) {
      throw new TeamProjectContextUnavailableError('Oversized project-context index');
    }
    try {
      return validateIndex(JSON.parse(content) as unknown, logicalTeamName);
    } catch {
      throw new TeamProjectContextUnavailableError('Corrupt project-context index');
    }
  }

  private async writeIndex(index: TeamProjectContextIndex): Promise<void> {
    const payload = JSON.stringify(index, null, 2) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > MAX_INDEX_BYTES) {
      throw new TeamProjectContextUnavailableError('Project-context index limit exceeded');
    }
    await atomicWriteAsync(this.indexPath(index.logicalTeamName), payload, {
      mode: 0o600,
      directoryMode: 0o700,
    });
  }

  /** Read-only queries never create a physical context or mutate a native team. */
  async find(logicalTeamName: string, projectPath: string): Promise<PersistedTeamWorkContext | null> {
    await this.assertOwnedDirectory(logicalTeamName);
    const projectKey = await canonicalProjectPath(projectPath);
    const index = await this.readIndex(logicalTeamName);
    const row = index.contexts.find((c) => c.projectKey === projectKey);
    if (!row) return null;
    if (row.state !== 'ready') {
      throw new TeamProjectContextUnavailableError('Project context creation is incomplete');
    }
    await this.assertOwnedDirectory(row.executionTeamName);
    return row;
  }

  /**
   * Single writer, idempotent after crash. A reserved alias with an uncertain
   * owner is never taken over; it must be reconciled explicitly.
   */
  async getOrCreate(
    logicalTeamName: string,
    projectPath: string
  ): Promise<PersistedTeamWorkContext> {
    await this.assertOwnedDirectory(logicalTeamName);
    const projectKey = await canonicalProjectPath(projectPath);
    const target = this.indexPath(logicalTeamName);
    return withFileLock(target, async () => {
      await this.assertOwnedDirectory(logicalTeamName);
      const index = await this.readIndex(logicalTeamName);
      let row = index.contexts.find((c) => c.projectKey === projectKey);
      if (!row) {
        if (index.contexts.length >= MAX_PROJECT_CONTEXTS) {
          throw new TeamProjectContextUnavailableError('Team has too many project contexts');
        }
        let executionTeamName: string | null = null;
        for (let i = 0; i < 8; i++) {
          const candidate = 'ptc-' + randomUUID().replaceAll('-', '').slice(0, 24);
          if (
            !index.contexts.some((c) => c.executionTeamName === candidate) &&
            !(await exists(path.join(this.paths.teamsBasePath, candidate))) &&
            !(await exists(path.join(this.paths.tasksBasePath, candidate)))
          ) {
            executionTeamName = candidate;
            break;
          }
        }
        if (!executionTeamName) {
          throw new TeamProjectContextUnavailableError('Could not reserve a unique team context');
        }
        row = {
          id: randomUUID(),
          projectKey,
          projectPath: projectKey,
          executionTeamName,
          state: 'reserved',
        };
        index.contexts.push(row);
        await this.writeIndex(index);
      }

      const physicalTeamPath = path.join(this.paths.teamsBasePath, row.executionTeamName);
      const physicalTasksPath = path.join(this.paths.tasksBasePath, row.executionTeamName);
      if (row.state === 'ready') {
        await this.assertOwnedDirectory(row.executionTeamName);
        return row;
      }
      // A pre-existing unmarked alias after crash is ambiguous: never claim it.
      if (await exists(physicalTeamPath)) {
        await this.assertOwnedDirectory(row.executionTeamName);
      } else {
        if (await exists(physicalTasksPath)) {
          throw new TeamProjectContextUnavailableError('Reserved task directory collision');
        }
        await fs.mkdir(physicalTeamPath, { mode: 0o700 });
        await claimTeamForThisProfile({
          teamName: row.executionTeamName,
          teamsBasePath: this.paths.teamsBasePath,
          reason: 'create',
          profileScope: this.paths.profileScope,
        });
      }
      await fs.mkdir(physicalTasksPath, { mode: 0o700, recursive: true });
      await fs.mkdir(path.join(physicalTeamPath, 'inboxes'), { mode: 0o700, recursive: true });
      const ready: PersistedTeamWorkContext = { ...row, state: 'ready' };
      index.contexts = index.contexts.map((c) => (c.id === row.id ? ready : c));
      await this.writeIndex(index);
      return ready;
    }, { preventLiveOwnerTakeover: true });
  }
}
