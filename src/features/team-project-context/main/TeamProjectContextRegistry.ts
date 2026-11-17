import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { withFileLock } from '@main/services/team/fileLock';
import {
  readTeamOwnerProfileScope,
  resolveThisAppProfileScope,
} from '@main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';

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
  deleting?: boolean;
  softDeleting?: boolean;
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
  // Legacy shared team names have historically allowed 128 characters and
  // a trailing hyphen; the generated alias constraint stays at 64 chars.
  const checked = validateTeamName(teamName);
  if (!checked.valid) throw new TeamProjectContextUnavailableError('Invalid team identifier');
  return checked.value!;
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
    // Windows paths have case-insensitive identity. Old stored indexes or
    // imported fixtures may preserve mixed-case realpath spelling, whereas
    // newly resolved project keys are lowercase. Normalize only the lookup
    // key in memory; do not rewrite the saved manifest on a read.
    const projectKey =
      typeof row.projectKey === 'string'
        ? (process.platform === 'win32'
            ? path.win32.normalize(row.projectKey).toLowerCase()
            : row.projectKey)
        : null;
    if (
      typeof row.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(row.id) ||
      projectKey === null ||
      !path.isAbsolute(projectKey) ||
      typeof row.projectPath !== 'string' ||
      !path.isAbsolute(row.projectPath) ||
      typeof row.executionTeamName !== 'string' ||
      !TEAM_NAME.test(row.executionTeamName) ||
      row.executionTeamName.length > 64 ||
      row.executionTeamName === logicalTeamName ||
      (row.state !== 'reserved' && row.state !== 'ready') ||
      projectKeys.has(projectKey) ||
      executionNames.has(row.executionTeamName)
    ) {
      throw new TeamProjectContextUnavailableError('Invalid or duplicate project-context entry');
    }
    projectKeys.add(projectKey);
    executionNames.add(row.executionTeamName);
    contexts.push({ ...row, projectKey } as PersistedTeamWorkContext);
  }
  if (source.deleting !== undefined && typeof source.deleting !== 'boolean') {
    throw new TeamProjectContextUnavailableError('Invalid project-context deletion state');
  }
  if (source.softDeleting !== undefined && typeof source.softDeleting !== 'boolean') {
    throw new TeamProjectContextUnavailableError('Invalid project-context trash state');
  }
  return {
    version: 1,
    logicalTeamName,
    ...(source.deleting ? { deleting: true } : {}),
    ...(source.softDeleting ? { softDeleting: true } : {}),
    contexts,
  };
}

/**
 * Small app-owned index. Physical context folders remain in the native CLI's
 * canonical teams/tasks roots; this class does not rewrite those storage APIs.
 * All public methods require a proven app-profile-owned logical team.
 */
export class TeamProjectContextRegistry {
  constructor(private readonly paths: TeamProjectContextRegistryPaths) {}

  static fromCurrentApp(): TeamProjectContextRegistry {
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

  /** Serialize project creation against a logical team move to trash. */
  async beginSoftDelete(logicalTeamName: string): Promise<void> {
    await this.assertOwnedDirectory(logicalTeamName);
    await withFileLock(this.indexPath(logicalTeamName), async () => {
      await this.assertOwnedDirectory(logicalTeamName);
      const index = await this.readIndex(logicalTeamName);
      if (index.deleting) {
        throw new TeamProjectContextUnavailableError('Permanent deletion is already in progress');
      }
      index.softDeleting = true;
      await this.writeIndex(index);
    }, { preventLiveOwnerTakeover: true });
  }

  /** Unfreeze the team after successful restore or rejected trash preflight. */
  async cancelSoftDelete(logicalTeamName: string): Promise<void> {
    await this.assertOwnedDirectory(logicalTeamName);
    await withFileLock(this.indexPath(logicalTeamName), async () => {
      await this.assertOwnedDirectory(logicalTeamName);
      const index = await this.readIndex(logicalTeamName);
      if (index.deleting) {
        throw new TeamProjectContextUnavailableError('Permanent deletion is already in progress');
      }
      if (!index.softDeleting) return;
      delete index.softDeleting;
      await this.writeIndex(index);
    }, { preventLiveOwnerTakeover: true });
  }

  /** Block new reservations before a multi-context permanent deletion starts. */
  async beginPermanentDeletion(logicalTeamName: string): Promise<void> {
    await this.assertOwnedDirectory(logicalTeamName);
    await withFileLock(this.indexPath(logicalTeamName), async () => {
      await this.assertOwnedDirectory(logicalTeamName);
      const index = await this.readIndex(logicalTeamName);
      if (index.deleting) return;
      index.deleting = true;
      await this.writeIndex(index);
    }, { preventLiveOwnerTakeover: true });
  }

  /** Undo the admission fence only if deletion preflight has not removed data. */
  async cancelPermanentDeletion(logicalTeamName: string): Promise<void> {
    await this.assertOwnedDirectory(logicalTeamName);
    await withFileLock(this.indexPath(logicalTeamName), async () => {
      await this.assertOwnedDirectory(logicalTeamName);
      const index = await this.readIndex(logicalTeamName);
      if (!index.deleting) return;
      delete index.deleting;
      await this.writeIndex(index);
    }, { preventLiveOwnerTakeover: true });
  }

  /**
   * A scheduling target is a project alias only when an owned, validated
   * logical team's manifest explicitly maps to it. Never trust the prefix.
   * This is used only at schedule admission/dispatch, not on hot UI reads.
   */
  async resolveOwnedExecutionAlias(executionTeamName: string): Promise<{
    logicalTeamName: string;
    context: PersistedTeamWorkContext;
  } | null> {
    if (!executionTeamName.startsWith('ptc-')) return null;
    const entries = await fs.readdir(this.paths.teamsBasePath, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    let match: { logicalTeamName: string; context: PersistedTeamWorkContext } | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === executionTeamName) continue;
      if (!validateTeamName(entry.name).valid) continue;
      const dir = path.join(this.paths.teamsBasePath, entry.name);
      if (!(await exists(path.join(dir, INDEX_FILE)))) continue;
      if ((await readTeamOwnerProfileScope(dir)) !== this.paths.profileScope) continue;
      const index = await this.readIndex(entry.name);
      const context = index.contexts.find((row) => row.executionTeamName === executionTeamName);
      if (!context) continue;
      if (match) throw new TeamProjectContextUnavailableError('Ambiguous project runtime alias');
      if (context.state === 'ready') await this.assertOwnedDirectory(executionTeamName);
      match = { logicalTeamName: entry.name, context };
    }
    return match;
  }

  async isOwnedExecutionAlias(executionTeamName: string): Promise<boolean> {
    return (await this.resolveOwnedExecutionAlias(executionTeamName)) !== null;
  }

  /** A retained index may outlive the selected history mode. */
  async hasRetainedIndex(logicalTeamName: string): Promise<boolean> {
    return exists(this.indexPath(logicalTeamName));
  }

  /** Legacy shared teams without an index are unchanged, including ownership. */
  async listRetained(logicalTeamName: string): Promise<readonly PersistedTeamWorkContext[]> {
    if (!(await this.hasRetainedIndex(logicalTeamName))) return [];
    return this.list(logicalTeamName);
  }

  /**
   * Enumerate only verified native aliases; never treat a matching name prefix
   * as proof that a directory belongs to this team or this app profile.
   */
  async list(logicalTeamName: string): Promise<readonly PersistedTeamWorkContext[]> {
    await this.assertOwnedDirectory(logicalTeamName);
    const index = await this.readIndex(logicalTeamName);
    if (index.deleting) {
      throw new TeamProjectContextUnavailableError('Team permanent deletion is in progress');
    }
    const { contexts } = index;
    for (const row of contexts) {
      // Reservations are visible to lifecycle admission but are not readable
      // native histories. Do not suppress the logical team while a launch
      // is preparing its first physical context.
      if (row.state === 'ready') {
        await this.assertOwnedDirectory(row.executionTeamName);
      }
    }
    return contexts;
  }

  /**
   * Reserved aliases can contain a live process before native provisioning
   * emits ready. Never stop one unless its alias comes from this team's
   * manifest AND its current owner marker proves this app profile.
   */
  async assertReservedStopOwnership(
    logicalTeamName: string,
    executionTeamName: string
  ): Promise<void> {
    await this.assertOwnedDirectory(logicalTeamName);
    const row = (await this.readIndex(logicalTeamName)).contexts.find(
      (context) =>
        context.executionTeamName === executionTeamName && context.state === 'reserved'
    );
    if (!row) throw new TeamProjectContextUnavailableError('Unknown pending project runtime');
    await this.assertOwnedDirectory(row.executionTeamName);
  }

  /**
   * Read-only inspection for navigation. Reserved entries are distinct from
   * ready native contexts and never authorize task or message access.
   */
  async inspect(
    logicalTeamName: string,
    projectPath: string
  ): Promise<PersistedTeamWorkContext | null> {
    await this.assertOwnedDirectory(logicalTeamName);
    const projectKey = await canonicalProjectPath(projectPath);
    const index = await this.readIndex(logicalTeamName);
    if (index.deleting || index.softDeleting) {
      throw new TeamProjectContextUnavailableError('Team is being deleted or moved to trash');
    }
    const row = index.contexts.find((context) => context.projectKey === projectKey);
    if (row?.state === 'ready') await this.assertOwnedDirectory(row.executionTeamName);
    return row ?? null;
  }

  /** Only verified ready contexts qualify for history reads and writes. */
  async find(logicalTeamName: string, projectPath: string): Promise<PersistedTeamWorkContext | null> {
    const row = await this.inspect(logicalTeamName, projectPath);
    if (row?.state === 'reserved') {
      throw new TeamProjectContextUnavailableError('Project context creation is incomplete');
    }
    return row;
  }

  /**
   * Inspect a permanent-deletion transaction. A context fully removed in an
   * interrupted earlier attempt is still eligible for index cleanup. Any
   * remaining physical directory must prove the same app-profile ownership.
   */
  async listForPermanentDeletion(
    logicalTeamName: string
  ): Promise<readonly PersistedTeamWorkContext[]> {
    await this.assertOwnedDirectory(logicalTeamName);
    const rows = (await this.readIndex(logicalTeamName)).contexts;
    for (const row of rows) {
      const teamDir = path.join(this.paths.teamsBasePath, row.executionTeamName);
      const tasksDir = path.join(this.paths.tasksBasePath, row.executionTeamName);
      const teamExists = await exists(teamDir);
      if (!teamExists) {
        if (await exists(tasksDir)) {
          throw new TeamProjectContextUnavailableError(
            'Cannot safely delete an unowned orphan task directory'
          );
        }
        continue;
      }
      await this.assertOwnedDirectory(row.executionTeamName);
    }
    return rows;
  }

  /**
   * Advance deletion only after native cleanup has actually removed both
   * physical roots. A retry after a crash can finish the remaining contexts.
   */
  async forgetPermanentlyDeletedContext(
    logicalTeamName: string,
    executionTeamName: string,
    expectedId: string
  ): Promise<boolean> {
    await this.assertOwnedDirectory(logicalTeamName);
    return withFileLock(this.indexPath(logicalTeamName), async () => {
      await this.assertOwnedDirectory(logicalTeamName);
      const index = await this.readIndex(logicalTeamName);
      const entry = index.contexts.find(
        (row) => row.executionTeamName === executionTeamName && row.id === expectedId
      );
      if (!entry) return false;
      if (
        (await exists(path.join(this.paths.teamsBasePath, entry.executionTeamName))) ||
        (await exists(path.join(this.paths.tasksBasePath, entry.executionTeamName)))
      ) {
        throw new TeamProjectContextUnavailableError(
          'Native project data still exists after permanent deletion'
        );
      }
      index.contexts = index.contexts.filter((row) => row.id !== entry.id);
      await this.writeIndex(index);
      return true;
    }, { preventLiveOwnerTakeover: true });
  }

  /**
   * Reserve an opaque native name without creating a physical directory.
   * The EXISTING Team Provisioning create flow remains the sole writer of
   * native team config, tasks and launch state.
   */
  async reserve(
    logicalTeamName: string,
    projectPath: string
  ): Promise<PersistedTeamWorkContext> {
    await this.assertOwnedDirectory(logicalTeamName);
    const projectKey = await canonicalProjectPath(projectPath);
    return withFileLock(this.indexPath(logicalTeamName), async () => {
      await this.assertOwnedDirectory(logicalTeamName);
      const index = await this.readIndex(logicalTeamName);
      if (index.deleting || index.softDeleting) {
        throw new TeamProjectContextUnavailableError(
          'Team deletion or trash operation is in progress; new project contexts are disabled'
        );
      }
      const existing = index.contexts.find((c) => c.projectKey === projectKey);
      if (existing) {
        if (existing.state === 'ready') await this.assertOwnedDirectory(existing.executionTeamName);
        return existing;
      }
      if (index.contexts.length >= MAX_PROJECT_CONTEXTS) {
        throw new TeamProjectContextUnavailableError('Team has too many project contexts');
      }
      let executionTeamName: string | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
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
      const reserved: PersistedTeamWorkContext = {
        id: randomUUID(),
        projectKey,
        projectPath: projectKey,
        executionTeamName,
        state: 'reserved',
      };
      index.contexts.push(reserved);
      await this.writeIndex(index);
      return reserved;
    }, { preventLiveOwnerTakeover: true });
  }

  /**
   * Release a failed draft reservation only when absolutely no native artifact
   * exists. The caller must hold the logical team's operation admission lock
   * and prove that no provisioning run is active. Never delete ready contexts.
   */
  async releaseUnusedReservation(
    logicalTeamName: string,
    executionTeamName: string,
    expectedContextId: string
  ): Promise<boolean> {
    await this.assertOwnedDirectory(logicalTeamName);
    return withFileLock(this.indexPath(logicalTeamName), async () => {
      await this.assertOwnedDirectory(logicalTeamName);
      const index = await this.readIndex(logicalTeamName);
      const row = index.contexts.find(
        (entry) =>
          entry.executionTeamName === executionTeamName && entry.id === expectedContextId
      );
      if (!row || row.state !== 'reserved') return false;
      if (
        (await exists(path.join(this.paths.teamsBasePath, row.executionTeamName))) ||
        (await exists(path.join(this.paths.tasksBasePath, row.executionTeamName)))
      ) {
        return false;
      }
      index.contexts = index.contexts.filter((entry) => entry.id !== row.id);
      await this.writeIndex(index);
      return true;
    }, { preventLiveOwnerTakeover: true });
  }

  async confirmReady(
    logicalTeamName: string,
    projectPath: string,
    executionTeamName: string
  ): Promise<PersistedTeamWorkContext> {
    await this.assertOwnedDirectory(logicalTeamName);
    const projectKey = await canonicalProjectPath(projectPath);
    return withFileLock(this.indexPath(logicalTeamName), async () => {
      await this.assertOwnedDirectory(logicalTeamName);
      const index = await this.readIndex(logicalTeamName);
      if (index.deleting || index.softDeleting) {
        throw new TeamProjectContextUnavailableError(
          'Cannot confirm a project context while the team is being deleted'
        );
      }
      const row = index.contexts.find((c) => c.projectKey === projectKey);
      if (!row || row.executionTeamName !== executionTeamName) {
        throw new TeamProjectContextUnavailableError('Unrecognized project context confirmation');
      }
      await this.assertOwnedDirectory(row.executionTeamName);
      for (const required of [
        path.join(this.paths.teamsBasePath, row.executionTeamName, 'config.json'),
        path.join(this.paths.tasksBasePath, row.executionTeamName),
      ]) {
        const stat = await fs.lstat(required);
        if (stat.isSymbolicLink() || !(required.endsWith('.json') ? stat.isFile() : stat.isDirectory())) {
          throw new TeamProjectContextUnavailableError('Native project context is incomplete');
        }
      }
      if (row.state === 'ready') return row;
      const ready: PersistedTeamWorkContext = { ...row, state: 'ready' };
      index.contexts = index.contexts.map((c) => c.id === ready.id ? ready : c);
      await this.writeIndex(index);
      return ready;
    }, { preventLiveOwnerTakeover: true });
  }
}
