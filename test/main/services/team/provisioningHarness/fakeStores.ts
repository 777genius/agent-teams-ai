import { readdir, readFile } from 'fs/promises';
import * as path from 'path';

import { assertNoSecretLikeFixtureValues } from './fixtures';
import {
  cloneFixture,
  normalizeMembers,
  normalizeMembersMetaFile,
  normalizeTeamMeta,
} from './harnessData';
import {
  readHarnessJsonFile,
  type TeamProvisioningHarnessPaths,
  validateConfigMemberPathSegments,
  validateStoredMemberPathSegments,
  validateTeamNamePathSegment,
  writeJsonFile,
} from './harnessFilesystem';

import type {
  HarnessBootstrapStateStorePort,
  HarnessLaunchStateStorePort,
  HarnessRuntimeStorePort,
  HarnessTeamConfigReaderPort,
  HarnessTeamInboxReaderPort,
  HarnessTeamMembersMetaStorePort,
  HarnessTeamMetaStorePort,
  TeamProvisioningHarnessStores,
} from './TeamProvisioningHarnessBuilder';
import type { TeamMembersMetaFile } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
import type { TeamConfig, TeamMember } from '@shared/types';

class FakeTeamConfigReader {
  private readonly configs = new Map<string, TeamConfig>();

  constructor(
    configs: Iterable<readonly [string, TeamConfig]> = [],
    private readonly paths?: TeamProvisioningHarnessPaths
  ) {
    for (const [teamName, config] of configs) {
      this.setConfig(teamName, config);
    }
  }

  setConfig(teamName: string, config: TeamConfig): void {
    validateTeamNamePathSegment(teamName);
    validateConfigMemberPathSegments(config);
    assertNoSecretLikeFixtureValues({ teamName, config });
    this.configs.set(teamName, cloneFixture(config));
  }

  async getConfig(teamName: string): Promise<TeamConfig | null> {
    return this.getConfigSnapshot(teamName);
  }

  async getConfigVerified(teamName: string): Promise<TeamConfig | null> {
    return this.getConfigSnapshot(teamName);
  }

  async getConfigSnapshot(teamName: string): Promise<TeamConfig | null> {
    const fileConfig = await this.readConfigFromDisk(teamName);
    if (fileConfig !== undefined) {
      return fileConfig ? cloneFixture(fileConfig) : null;
    }

    const config = this.configs.get(teamName);
    return config ? cloneFixture(config) : null;
  }

  async readTeamConfigRaw(teamName: string): Promise<string | null> {
    const raw = await this.readConfigRawFromDisk(teamName);
    if (raw !== undefined) {
      return raw;
    }

    const config = await this.getConfigSnapshot(teamName);
    return config ? JSON.stringify(config, null, 2) : null;
  }

  private async readConfigFromDisk(teamName: string): Promise<TeamConfig | null | undefined> {
    const raw = await this.readConfigRawFromDisk(teamName);
    if (raw === undefined) {
      return undefined;
    }
    if (raw === null) {
      return null;
    }

    try {
      return JSON.parse(raw) as TeamConfig;
    } catch {
      return null;
    }
  }

  private async readConfigRawFromDisk(teamName: string): Promise<string | null | undefined> {
    if (!this.paths) {
      return undefined;
    }

    validateTeamNamePathSegment(teamName);
    try {
      return await readFile(this.paths.configPath(teamName), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

class FakeTeamMembersMetaStore {
  private readonly metaByTeam = new Map<string, TeamMembersMetaFile>();

  constructor(
    metaEntries: Iterable<readonly [string, TeamMembersMetaFile]> = [],
    private readonly paths?: TeamProvisioningHarnessPaths
  ) {
    for (const [teamName, meta] of metaEntries) {
      this.setMeta(teamName, meta);
    }
  }

  setMeta(teamName: string, meta: TeamMembersMetaFile): void {
    validateTeamNamePathSegment(teamName);
    assertNoSecretLikeFixtureValues({ teamName, meta });
    const normalizedMeta = normalizeMembersMetaFile(cloneFixture(meta));
    validateStoredMemberPathSegments(normalizedMeta.members);
    assertNoSecretLikeFixtureValues({ teamName, meta: normalizedMeta });
    this.metaByTeam.set(teamName, cloneFixture(normalizedMeta));
  }

  async getMeta(teamName: string): Promise<TeamMembersMetaFile | null> {
    const fileMeta = await this.readMetaFromDisk(teamName);
    if (fileMeta !== undefined) {
      return fileMeta ? cloneFixture(fileMeta) : null;
    }

    const meta = this.metaByTeam.get(teamName);
    return meta ? cloneFixture(meta) : null;
  }

  async getMembers(teamName: string): Promise<TeamMember[]> {
    return cloneFixture((await this.getMeta(teamName))?.members ?? []);
  }

  async writeMembers(
    teamName: string,
    members: TeamMember[],
    options?: { providerBackendId?: string }
  ): Promise<void> {
    const meta: TeamMembersMetaFile = {
      version: 1,
      providerBackendId: options?.providerBackendId,
      members: normalizeMembers(members),
    };
    this.setMeta(teamName, meta);
    if (this.paths) {
      await writeJsonFile(this.paths.membersMetaPath(teamName), meta);
    }
  }

  private async readMetaFromDisk(
    teamName: string
  ): Promise<TeamMembersMetaFile | null | undefined> {
    if (!this.paths) {
      return undefined;
    }

    validateTeamNamePathSegment(teamName);
    try {
      const raw = await readFile(this.paths.membersMetaPath(teamName), 'utf8');
      return normalizeMembersMetaFile(JSON.parse(raw) as TeamMembersMetaFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

class FakeTeamMetaStore {
  private readonly metaByTeam = new Map<string, TeamMetaFile>();

  constructor(
    metaEntries: Iterable<readonly [string, TeamMetaFile]> = [],
    private readonly paths?: TeamProvisioningHarnessPaths
  ) {
    for (const [teamName, meta] of metaEntries) {
      this.setMeta(teamName, meta);
    }
  }

  setMeta(teamName: string, meta: TeamMetaFile): void {
    validateTeamNamePathSegment(teamName);
    assertNoSecretLikeFixtureValues({ teamName, meta });
    this.metaByTeam.set(teamName, cloneFixture(meta));
  }

  async getMeta(teamName: string): Promise<TeamMetaFile | null> {
    const fileMeta = await this.readMetaFromDisk(teamName);
    if (fileMeta !== undefined) {
      return fileMeta ? cloneFixture(fileMeta) : null;
    }

    const meta = this.metaByTeam.get(teamName);
    return meta ? cloneFixture(meta) : null;
  }

  private async readMetaFromDisk(teamName: string): Promise<TeamMetaFile | null | undefined> {
    if (!this.paths) {
      return undefined;
    }

    validateTeamNamePathSegment(teamName);
    try {
      const raw = await readFile(this.paths.teamMetaPath(teamName), 'utf8');
      return normalizeTeamMeta(JSON.parse(raw) as TeamMetaFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

class FakeTeamInboxReader {
  constructor(private readonly paths: TeamProvisioningHarnessPaths) {}

  async listInboxNames(teamName: string): Promise<string[]> {
    validateTeamNamePathSegment(teamName);
    const inboxDir = path.join(this.paths.teamDir(teamName), 'inboxes');

    let entries: string[];
    try {
      entries = await readdir(inboxDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    return entries
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => name.replace(/\.json$/, ''))
      .filter((name) => name !== '*');
  }
}

class FakeLaunchStateStore {
  constructor(private readonly paths: TeamProvisioningHarnessPaths) {}

  async read(teamName: string): Promise<unknown> {
    return readHarnessJsonFile(this.paths.launchStatePath(teamName));
  }
}

class FakeBootstrapStateStore {
  constructor(private readonly paths: TeamProvisioningHarnessPaths) {}

  async read(teamName: string): Promise<unknown> {
    return readHarnessJsonFile(this.paths.bootstrapStatePath(teamName));
  }
}

class FakeRuntimeStore {
  constructor(private readonly paths: TeamProvisioningHarnessPaths) {}

  async read(teamName: string): Promise<unknown> {
    return readHarnessJsonFile(this.paths.runtimeStorePath(teamName));
  }
}

function createConfigReaderPort(reader: FakeTeamConfigReader): HarnessTeamConfigReaderPort {
  return {
    getConfig: (teamName) => reader.getConfig(teamName),
    getConfigVerified: (teamName) => reader.getConfigVerified(teamName),
    getConfigSnapshot: (teamName) => reader.getConfigSnapshot(teamName),
    readTeamConfigRaw: (teamName) => reader.readTeamConfigRaw(teamName),
  };
}

function createMembersMetaStorePort(
  store: FakeTeamMembersMetaStore
): HarnessTeamMembersMetaStorePort {
  return {
    getMeta: (teamName) => store.getMeta(teamName),
    getMembers: (teamName) => store.getMembers(teamName),
    writeMembers: (teamName, members, options) => store.writeMembers(teamName, members, options),
  };
}

function createTeamMetaStorePort(store: FakeTeamMetaStore): HarnessTeamMetaStorePort {
  return {
    getMeta: (teamName) => store.getMeta(teamName),
  };
}

function createInboxReaderPort(reader: FakeTeamInboxReader): HarnessTeamInboxReaderPort {
  return {
    listInboxNames: (teamName) => reader.listInboxNames(teamName),
  };
}

function createLaunchStateStorePort(store: FakeLaunchStateStore): HarnessLaunchStateStorePort {
  return {
    read: (teamName) => store.read(teamName),
  };
}

function createBootstrapStateStorePort(
  store: FakeBootstrapStateStore
): HarnessBootstrapStateStorePort {
  return {
    read: (teamName) => store.read(teamName),
  };
}

function createRuntimeStorePort(store: FakeRuntimeStore): HarnessRuntimeStorePort {
  return {
    read: (teamName) => store.read(teamName),
  };
}

export function createHarnessStores(
  paths: TeamProvisioningHarnessPaths,
  configs: ReadonlyMap<string, TeamConfig>,
  teamMeta: ReadonlyMap<string, TeamMetaFile>,
  membersMeta: ReadonlyMap<string, TeamMembersMetaFile>
): TeamProvisioningHarnessStores {
  const configReader = new FakeTeamConfigReader(configs.entries(), paths);
  const teamMetaStore = new FakeTeamMetaStore(teamMeta.entries(), paths);
  const membersMetaStore = new FakeTeamMembersMetaStore(membersMeta.entries(), paths);
  const inboxReader = new FakeTeamInboxReader(paths);
  const launchStateStore = new FakeLaunchStateStore(paths);
  const bootstrapStateStore = new FakeBootstrapStateStore(paths);
  const runtimeStore = new FakeRuntimeStore(paths);

  return {
    configReader: createConfigReaderPort(configReader),
    inboxReader: createInboxReaderPort(inboxReader),
    launchStateStore: createLaunchStateStorePort(launchStateStore),
    bootstrapStateStore: createBootstrapStateStorePort(bootstrapStateStore),
    runtimeStore: createRuntimeStorePort(runtimeStore),
    teamMetaStore: createTeamMetaStorePort(teamMetaStore),
    membersMetaStore: createMembersMetaStorePort(membersMetaStore),
  };
}
