import {
  type TeamProvisioningConfigFacade,
  type TeamProvisioningConfigFacadeInboxReader,
  type TeamProvisioningConfigFacadeReader,
} from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import { type TeamProvisioningLaunchExpectedMembersPorts } from '@main/services/team/provisioning/TeamProvisioningLaunchExpectedMembers';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { rm } from 'fs/promises';

import { createHarnessFacades, createHarnessStores, HarnessLogger } from './fakes';
import {
  assertNoSecretLikeFixtureValues,
  HARNESS_DEFAULT_NOW_ISO,
  HARNESS_DEFAULT_TEAM_NAME,
  memberFixture,
  normalizeMembersMetaFixture,
  normalizeTeamConfigFixture,
  teamConfigFixture,
  teamMetaFixture,
} from './fixtures';
import { cloneFixture, normalizeTeamMeta, toIsoString } from './harnessData';
import {
  assertValidJsonFixture,
  createTempWorkspace,
  type TeamProvisioningHarnessPaths,
  type TempWorkspaceOptions,
  validateConfigMemberPathSegments,
  validateMemberNamePathSegment,
  validateMemberPathSegments,
  validateTeamNamePathSegment,
  validateTempWorkspaceOptions,
  writeHarnessFiles,
  writeHarnessStateFiles,
} from './harnessFilesystem';
import { applyHarnessPathOverride, assertCanApplyPathOverride } from './harnessPathOverride';
import {
  type HarnessCleanupFn,
  HarnessClock,
  HarnessUuidSource,
  runCleanupFns,
  TeamProvisioningHarnessImpl,
} from './harnessRuntime';

import type { TeamProvisioningConfigMaintenanceMembersMetaStore } from '@main/services/team/provisioning/TeamProvisioningConfigMaintenance';
import type {
  TeamMembersMetaFile,
  TeamMembersMetaStore,
} from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaFile, TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type { TeamConfig, TeamMember } from '@shared/types';

export type { TeamProvisioningHarnessPaths, TempWorkspaceOptions } from './harnessFilesystem';

export interface HarnessTeamConfigReaderPort extends TeamProvisioningConfigFacadeReader {
  getConfigVerified(teamName: string): Promise<TeamConfig | null>;
  getConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readTeamConfigRaw(teamName: string): Promise<string | null>;
}

export type HarnessTeamMetaStorePort = Pick<TeamMetaStore, 'getMeta'>;

export type HarnessTeamMembersMetaStorePort = Pick<TeamMembersMetaStore, 'getMeta'> &
  TeamProvisioningConfigMaintenanceMembersMetaStore;

export type HarnessTeamInboxReaderPort = TeamProvisioningConfigFacadeInboxReader;

export interface HarnessLaunchStateStorePort {
  read(teamName: string): Promise<unknown>;
}

export interface HarnessBootstrapStateStorePort {
  read(teamName: string): Promise<unknown>;
}

export interface HarnessRuntimeStorePort {
  read(teamName: string): Promise<unknown>;
}

export interface TeamProvisioningHarnessStores {
  configReader: HarnessTeamConfigReaderPort;
  inboxReader: HarnessTeamInboxReaderPort;
  launchStateStore: HarnessLaunchStateStorePort;
  bootstrapStateStore: HarnessBootstrapStateStorePort;
  runtimeStore: HarnessRuntimeStorePort;
  teamMetaStore: HarnessTeamMetaStorePort;
  membersMetaStore: HarnessTeamMembersMetaStorePort;
}

export interface TeamProvisioningHarnessFacades {
  configFacade: TeamProvisioningConfigFacade;
  launchExpectedMembersPorts: TeamProvisioningLaunchExpectedMembersPorts;
}

export interface TeamProvisioningHarnessClock {
  now(): Date;
  nowIso(): string;
  set(isoOrDate: string | Date): void;
}

export interface TeamProvisioningHarnessUuidSource {
  next(): string;
  generated(): readonly string[];
}

export type TeamProvisioningHarnessLogLevel = 'info' | 'warn' | 'debug';

export interface TeamProvisioningHarnessLogEntry {
  level: TeamProvisioningHarnessLogLevel;
  message: string;
}

export interface TeamProvisioningHarnessLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
  entries(): readonly TeamProvisioningHarnessLogEntry[];
}

export interface TeamProvisioningHarness {
  readonly teamName: string;
  readonly paths: TeamProvisioningHarnessPaths;
  readonly stores: TeamProvisioningHarnessStores;
  readonly facades: TeamProvisioningHarnessFacades;
  readonly clock: TeamProvisioningHarnessClock;
  readonly uuid: TeamProvisioningHarnessUuidSource;
  readonly logger: TeamProvisioningHarnessLogger;
  cleanup(): Promise<void>;
}

export class TeamProvisioningHarnessBuilder {
  private tempWorkspaceOptions: TempWorkspaceOptions = {};
  private defaultTeamName = HARNESS_DEFAULT_TEAM_NAME;
  private clockIso = HARNESS_DEFAULT_NOW_ISO;
  private uuidSequence: readonly string[] = [];
  private readonly teamConfigs = new Map<string, TeamConfig | null>();
  private readonly teamMeta = new Map<string, TeamMetaFile>();
  private readonly membersMeta = new Map<string, TeamMembersMetaFile>();
  private readonly inboxMessages = new Map<string, Map<string, readonly unknown[]>>();
  private readonly launchStates = new Map<string, unknown>();
  private readonly bootstrapStates = new Map<string, unknown>();
  private readonly runtimeStores = new Map<string, unknown>();

  static create(): TeamProvisioningHarnessBuilder {
    return new TeamProvisioningHarnessBuilder();
  }

  withTempWorkspace(options: TempWorkspaceOptions = {}): this {
    this.tempWorkspaceOptions = {
      ...this.tempWorkspaceOptions,
      ...options,
    };
    return this;
  }

  withClock(isoOrDate: string | Date): this {
    this.clockIso = toIsoString(isoOrDate);
    return this;
  }

  withUuidSequence(sequence: readonly string[]): this {
    assertNoSecretLikeFixtureValues(sequence);
    this.uuidSequence = [...sequence];
    return this;
  }

  withTeam(teamName: string, config?: TeamConfig): this {
    if (this.teamConfigs.size === 0) {
      this.defaultTeamName = teamName;
    }
    this.teamConfigs.set(teamName, config ? cloneFixture(config) : null);
    return this;
  }

  withTeamMeta(teamName: string, meta: TeamMetaFile | Omit<TeamMetaFile, 'version'>): this {
    const normalized = normalizeTeamMeta(meta);
    assertNoSecretLikeFixtureValues({ teamName, meta: normalized });
    this.teamMeta.set(teamName, cloneFixture(normalized));
    return this;
  }

  withMembersMeta(
    teamName: string,
    members: readonly TeamMember[],
    options: { providerBackendId?: string } = {}
  ): this {
    const meta: TeamMembersMetaFile = {
      version: 1,
      providerBackendId: options.providerBackendId,
      members: members.map((memberValue) => cloneFixture(memberValue)),
    };
    assertNoSecretLikeFixtureValues({ teamName, meta });
    this.membersMeta.set(teamName, meta);
    return this;
  }

  withInbox(teamName: string, memberName: string, messages: readonly unknown[] = []): this {
    const teamInboxes = this.inboxMessages.get(teamName) ?? new Map<string, readonly unknown[]>();
    teamInboxes.set(memberName, cloneFixture(messages));
    this.inboxMessages.set(teamName, teamInboxes);
    return this;
  }

  withLaunchState(teamName: string, snapshot: unknown): this {
    this.launchStates.set(teamName, cloneFixture(snapshot));
    return this;
  }

  withBootstrapState(teamName: string, snapshot: unknown): this {
    this.bootstrapStates.set(teamName, cloneFixture(snapshot));
    return this;
  }

  withRuntimeStore(teamName: string, store: unknown): this {
    this.runtimeStores.set(teamName, cloneFixture(store));
    return this;
  }

  async build(): Promise<TeamProvisioningHarness> {
    const snapshot = this.snapshotForBuild();
    snapshot.validateInputsBeforeSideEffects();
    return snapshot.buildFromSnapshot();
  }

  private snapshotForBuild(): TeamProvisioningHarnessBuilder {
    const snapshot = new TeamProvisioningHarnessBuilder();
    snapshot.tempWorkspaceOptions = { ...this.tempWorkspaceOptions };
    snapshot.defaultTeamName = this.defaultTeamName;
    snapshot.clockIso = this.clockIso;
    snapshot.uuidSequence = [...this.uuidSequence];

    for (const [teamName, config] of this.teamConfigs) {
      snapshot.teamConfigs.set(teamName, cloneFixture(config));
    }
    for (const [teamName, meta] of this.teamMeta) {
      snapshot.teamMeta.set(teamName, cloneFixture(meta));
    }
    for (const [teamName, meta] of this.membersMeta) {
      snapshot.membersMeta.set(teamName, cloneFixture(meta));
    }
    for (const [teamName, inboxes] of this.inboxMessages) {
      snapshot.inboxMessages.set(teamName, cloneFixture(inboxes));
    }
    for (const [teamName, launchState] of this.launchStates) {
      snapshot.launchStates.set(teamName, cloneFixture(launchState));
    }
    for (const [teamName, bootstrapState] of this.bootstrapStates) {
      snapshot.bootstrapStates.set(teamName, cloneFixture(bootstrapState));
    }
    for (const [teamName, runtimeStore] of this.runtimeStores) {
      snapshot.runtimeStores.set(teamName, cloneFixture(runtimeStore));
    }

    return snapshot;
  }

  private async buildFromSnapshot(): Promise<TeamProvisioningHarness> {
    const paths = await createTempWorkspace(this.tempWorkspaceOptions);
    const cleanupFns: HarnessCleanupFn[] = [() => rm(paths.root, { recursive: true, force: true })];

    try {
      if (this.tempWorkspaceOptions.applyPathOverride !== false) {
        cleanupFns.push(applyHarnessPathOverride(paths.claudeRoot));
      }

      const configs = this.createConfigFixtures(paths);
      const teamMeta = this.createTeamMetaFixtures(configs, paths);
      const membersMeta = this.createMembersMetaFixtures(configs, teamMeta);

      await writeHarnessFiles(paths, configs, teamMeta, membersMeta);
      await writeHarnessStateFiles(paths, {
        inboxMessages: this.inboxMessages,
        launchStates: this.launchStates,
        bootstrapStates: this.bootstrapStates,
        runtimeStores: this.runtimeStores,
      });

      const stores = createHarnessStores(paths, configs, teamMeta, membersMeta);
      const writeMembers = stores.membersMetaStore.writeMembers;
      stores.membersMetaStore.writeMembers = (teamName, members, options) => {
        const teammates = normalizeMembersMetaFixture(members);
        const providerId =
          teamMeta.get(teamName)?.providerId ??
          configs.get(teamName)?.members?.find((memberValue) => isLeadMember(memberValue))
            ?.providerId ??
          configs.get(teamName)?.members?.[0]?.providerId ??
          teammates[0]?.providerId;
        return writeMembers(teamName, teammates, {
          providerBackendId: migrateProviderBackendId(providerId, options?.providerBackendId),
        });
      };
      const harnessLogger = new HarnessLogger();

      return new TeamProvisioningHarnessImpl(
        this.defaultTeamName,
        paths,
        stores,
        createHarnessFacades(paths, stores, harnessLogger),
        new HarnessClock(this.clockIso),
        new HarnessUuidSource(this.uuidSequence),
        harnessLogger,
        cleanupFns
      );
    } catch (error) {
      await runCleanupFns(cleanupFns);
      throw error;
    }
  }

  private validateInputsBeforeSideEffects(): void {
    validateTempWorkspaceOptions(this.tempWorkspaceOptions);
    if (this.tempWorkspaceOptions.applyPathOverride !== false) {
      assertCanApplyPathOverride();
    }

    validateTeamNamePathSegment(this.defaultTeamName);
    toIsoString(this.clockIso);
    assertNoSecretLikeFixtureValues(this.uuidSequence);
    for (const [teamName, config] of this.teamConfigs) {
      validateTeamNamePathSegment(teamName);
      validateConfigMemberPathSegments(config);
      assertNoSecretLikeFixtureValues({ teamName, config });
    }
    for (const [teamName, meta] of this.teamMeta) {
      validateTeamNamePathSegment(teamName);
      assertNoSecretLikeFixtureValues({ teamName, meta });
    }
    for (const [teamName, meta] of this.membersMeta) {
      validateTeamNamePathSegment(teamName);
      validateMemberPathSegments(meta.members);
      assertNoSecretLikeFixtureValues({ teamName, meta });
    }
    for (const [teamName, inboxes] of this.inboxMessages) {
      validateTeamNamePathSegment(teamName);
      for (const [memberName, messages] of inboxes) {
        validateMemberNamePathSegment(memberName);
        assertValidJsonFixture({ teamName, memberName, messages }, 'inbox fixture');
      }
    }
    for (const [teamName, snapshot] of this.launchStates) {
      validateTeamNamePathSegment(teamName);
      assertValidJsonFixture({ teamName, snapshot }, 'launch state fixture');
    }
    for (const [teamName, snapshot] of this.bootstrapStates) {
      validateTeamNamePathSegment(teamName);
      assertValidJsonFixture({ teamName, snapshot }, 'bootstrap state fixture');
    }
    for (const [teamName, store] of this.runtimeStores) {
      validateTeamNamePathSegment(teamName);
      assertValidJsonFixture({ teamName, store }, 'runtime store fixture');
    }
  }

  private createConfigFixtures(paths: TeamProvisioningHarnessPaths): Map<string, TeamConfig> {
    const configInputs: ReadonlyMap<string, TeamConfig | null> =
      this.teamConfigs.size > 0
        ? this.teamConfigs
        : new Map([[this.defaultTeamName, null] as const]);
    const configs = new Map<string, TeamConfig>();

    for (const [teamName, config] of configInputs) {
      const resolvedConfig = normalizeTeamConfigFixture(
        config ??
          teamConfigFixture.basic({
            teamName,
            projectPath: paths.projectPath,
            members: [memberFixture.lead(), memberFixture.codex('Builder')],
          })
      );
      assertNoSecretLikeFixtureValues({ teamName, config: resolvedConfig });
      configs.set(teamName, cloneFixture(resolvedConfig));
    }

    return configs;
  }

  private createTeamMetaFixtures(
    configs: ReadonlyMap<string, TeamConfig>,
    paths: TeamProvisioningHarnessPaths
  ): Map<string, TeamMetaFile> {
    const metaByTeam = new Map<string, TeamMetaFile>();

    for (const [teamName, config] of configs) {
      const rawMeta =
        this.teamMeta.get(teamName) ??
        teamMetaFixture.basic({
          displayName: config.name,
          description: config.description,
          color: config.color,
          cwd: config.projectPath ?? paths.projectPath,
          providerId:
            config.members?.find((memberValue) => isLeadMember(memberValue))?.providerId ??
            config.members?.[0]?.providerId ??
            'codex',
        });
      const meta: TeamMetaFile = {
        ...rawMeta,
        providerBackendId: migrateProviderBackendId(rawMeta.providerId, rawMeta.providerBackendId),
      };
      assertNoSecretLikeFixtureValues({ teamName, meta });
      metaByTeam.set(teamName, cloneFixture(meta));
    }

    return metaByTeam;
  }

  private createMembersMetaFixtures(
    configs: ReadonlyMap<string, TeamConfig>,
    teamMeta: ReadonlyMap<string, TeamMetaFile>
  ): Map<string, TeamMembersMetaFile> {
    const metaByTeam = new Map<string, TeamMembersMetaFile>();

    for (const [teamName, config] of configs) {
      const rawMeta =
        this.membersMeta.get(teamName) ??
        ({
          version: 1,
          members: config.members ?? [],
        } satisfies TeamMembersMetaFile);
      const teammates = normalizeMembersMetaFixture(rawMeta.members);
      const providerId =
        teamMeta.get(teamName)?.providerId ??
        config.members?.find((memberValue) => isLeadMember(memberValue))?.providerId ??
        config.members?.[0]?.providerId ??
        teammates[0]?.providerId;
      const meta: TeamMembersMetaFile = {
        version: 1,
        providerBackendId: migrateProviderBackendId(providerId, rawMeta.providerBackendId),
        members: teammates,
      };
      assertNoSecretLikeFixtureValues({ teamName, meta });
      metaByTeam.set(teamName, cloneFixture(meta));
    }

    return metaByTeam;
  }
}
