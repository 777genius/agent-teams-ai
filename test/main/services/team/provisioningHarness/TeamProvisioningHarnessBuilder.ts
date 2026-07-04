/* eslint-disable security/detect-non-literal-fs-filename -- Test harness paths are created under mkdtemp. */
import {
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  setClaudeBasePathOverride,
} from '@main/utils/pathDecoder';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { createCliAutoSuffixNameGuard } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  assertNoSecretLikeFixtureValues,
  HARNESS_DEFAULT_NOW_ISO,
  HARNESS_DEFAULT_TEAM_NAME,
  memberFixture,
  teamConfigFixture,
  teamMetaFixture,
} from './fixtures';

import type { TeamProvisioningConfigFacadeReader } from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import type { TeamProvisioningConfigMaintenanceMembersMetaStore } from '@main/services/team/provisioning/TeamProvisioningConfigMaintenance';
import type {
  TeamMembersMetaFile,
  TeamMembersMetaStore,
} from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaFile, TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type { TeamConfig, TeamMember } from '@shared/types';

const DEFAULT_TEMP_WORKSPACE_PREFIX = 'team-provisioning-harness-';
const DEFAULT_PROJECT_DIR_NAME = 'project';

export interface TeamProvisioningHarnessPaths {
  root: string;
  claudeRoot: string;
  teamsBase: string;
  tasksBase: string;
  projectsBase: string;
  projectPath: string;
  teamDir(teamName: string): string;
  configPath(teamName: string): string;
  teamMetaPath(teamName: string): string;
  membersMetaPath(teamName: string): string;
  inboxPath(teamName: string, memberName: string): string;
  launchStatePath(teamName: string): string;
  bootstrapStatePath(teamName: string): string;
  runtimeStorePath(teamName: string): string;
}

export interface HarnessTeamConfigReaderPort extends TeamProvisioningConfigFacadeReader {
  getConfigVerified(teamName: string): Promise<TeamConfig | null>;
  getConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readTeamConfigRaw(teamName: string): Promise<string | null>;
}

export type HarnessTeamMetaStorePort = Pick<TeamMetaStore, 'getMeta'>;

export type HarnessTeamMembersMetaStorePort = Pick<TeamMembersMetaStore, 'getMeta'> &
  TeamProvisioningConfigMaintenanceMembersMetaStore;

export interface TeamProvisioningHarnessStores {
  configReader: HarnessTeamConfigReaderPort;
  teamMetaStore: HarnessTeamMetaStorePort;
  membersMetaStore: HarnessTeamMembersMetaStorePort;
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

export interface TeamProvisioningHarness {
  readonly teamName: string;
  readonly paths: TeamProvisioningHarnessPaths;
  readonly stores: TeamProvisioningHarnessStores;
  readonly clock: TeamProvisioningHarnessClock;
  readonly uuid: TeamProvisioningHarnessUuidSource;
  cleanup(): Promise<void>;
}

export interface TempWorkspaceOptions {
  prefix?: string;
  projectDirName?: string;
  applyPathOverride?: boolean;
}

function cloneFixture<T>(value: T): T {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function toIsoString(isoOrDate: string | Date): string {
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid harness clock value: ${String(isoOrDate)}`);
  }
  return date.toISOString();
}

function normalizeTeamMeta(meta: TeamMetaFile | Omit<TeamMetaFile, 'version'>): TeamMetaFile {
  return {
    version: 1,
    ...meta,
  };
}

function normalizeOptionalBackendId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeFastMode(value: unknown): TeamMember['fastMode'] {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : undefined;
}

function normalizeMember(member: TeamMember): TeamMember | null {
  const trimmedName = member.name?.trim();
  if (!trimmedName) {
    return null;
  }

  const providerId = normalizeOptionalTeamProviderId(member.providerId);
  return {
    name: trimmedName,
    role: typeof member.role === 'string' ? member.role.trim() || undefined : undefined,
    workflow: typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined,
    isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
    providerId,
    providerBackendId: migrateProviderBackendId(
      providerId,
      normalizeOptionalBackendId(member.providerBackendId)
    ),
    model: typeof member.model === 'string' ? member.model.trim() || undefined : undefined,
    effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
    fastMode: normalizeFastMode(member.fastMode),
    mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
    agentType:
      typeof member.agentType === 'string' ? member.agentType.trim() || undefined : undefined,
    color: typeof member.color === 'string' ? member.color.trim() || undefined : undefined,
    joinedAt: typeof member.joinedAt === 'number' ? member.joinedAt : undefined,
    agentId: typeof member.agentId === 'string' ? member.agentId : undefined,
    cwd: typeof member.cwd === 'string' ? member.cwd.trim() || undefined : undefined,
    removedAt: typeof member.removedAt === 'number' ? member.removedAt : undefined,
  };
}

function buildActiveNameGuard(membersByName: Map<string, TeamMember>): (name: string) => boolean {
  const activeNames = Array.from(membersByName.values())
    .filter((member) => !member.removedAt)
    .map((member) => member.name);
  return createCliAutoSuffixNameGuard(activeNames);
}

function normalizeMembers(members: readonly TeamMember[]): TeamMember[] {
  const deduped = new Map<string, TeamMember>();
  for (const member of members) {
    const normalized = normalizeMember(member);
    if (!normalized) {
      continue;
    }
    deduped.set(normalized.name, normalized);
  }

  const allNames = Array.from(deduped.keys());
  const keepName = buildActiveNameGuard(deduped);
  for (const name of allNames) {
    if (!keepName(name)) {
      deduped.delete(name);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeMembersMetaFile(meta: TeamMembersMetaFile): TeamMembersMetaFile {
  return {
    version: 1,
    providerBackendId: normalizeOptionalBackendId(meta.providerBackendId),
    members: normalizeMembers(meta.members),
  };
}

class FakeTeamConfigReader {
  private readonly configs = new Map<string, TeamConfig>();

  constructor(configs: Iterable<readonly [string, TeamConfig]> = []) {
    for (const [teamName, config] of configs) {
      this.setConfig(teamName, config);
    }
  }

  setConfig(teamName: string, config: TeamConfig): void {
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
    const config = this.configs.get(teamName);
    return config ? cloneFixture(config) : null;
  }

  async readTeamConfigRaw(teamName: string): Promise<string | null> {
    const config = await this.getConfigSnapshot(teamName);
    return config ? JSON.stringify(config, null, 2) : null;
  }

  entries(): readonly (readonly [string, TeamConfig])[] {
    return Array.from(this.configs.entries(), ([teamName, config]) => [
      teamName,
      cloneFixture(config),
    ]);
  }
}

class FakeTeamMembersMetaStore {
  private readonly metaByTeam = new Map<string, TeamMembersMetaFile>();

  constructor(metaEntries: Iterable<readonly [string, TeamMembersMetaFile]> = []) {
    for (const [teamName, meta] of metaEntries) {
      this.setMeta(teamName, meta);
    }
  }

  setMeta(teamName: string, meta: TeamMembersMetaFile): void {
    assertNoSecretLikeFixtureValues({ teamName, meta });
    this.metaByTeam.set(teamName, normalizeMembersMetaFile(cloneFixture(meta)));
  }

  async getMeta(teamName: string): Promise<TeamMembersMetaFile | null> {
    const meta = this.metaByTeam.get(teamName);
    return meta ? cloneFixture(meta) : null;
  }

  async getMembers(teamName: string): Promise<TeamMember[]> {
    return (await this.getMeta(teamName))?.members ?? [];
  }

  async writeMembers(
    teamName: string,
    members: TeamMember[],
    options?: { providerBackendId?: string }
  ): Promise<void> {
    this.setMeta(teamName, {
      version: 1,
      providerBackendId: options?.providerBackendId,
      members: normalizeMembers(members),
    });
  }
}

class FakeTeamMetaStore {
  private readonly metaByTeam = new Map<string, TeamMetaFile>();

  constructor(metaEntries: Iterable<readonly [string, TeamMetaFile]> = []) {
    for (const [teamName, meta] of metaEntries) {
      this.setMeta(teamName, meta);
    }
  }

  setMeta(teamName: string, meta: TeamMetaFile): void {
    assertNoSecretLikeFixtureValues({ teamName, meta });
    this.metaByTeam.set(teamName, cloneFixture(meta));
  }

  async getMeta(teamName: string): Promise<TeamMetaFile | null> {
    const meta = this.metaByTeam.get(teamName);
    return meta ? cloneFixture(meta) : null;
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

interface HarnessPathOverrideLease {
  token: symbol;
  claudeRoot: string;
  previousClaudeBasePathOverride: string | null;
}

let activePathOverrideLease: HarnessPathOverrideLease | null = null;

function assertCanApplyPathOverride(): void {
  if (!activePathOverrideLease) {
    return;
  }

  throw new Error(
    `TeamProvisioningHarnessBuilder already owns a Claude path override for ${activePathOverrideLease.claudeRoot}; clean up the active harness before building another override-backed harness.`
  );
}

function applyHarnessPathOverride(claudeRoot: string): () => void {
  assertCanApplyPathOverride();

  const previousClaudeBasePath = getClaudeBasePath();
  const previousClaudeBasePathOverride =
    previousClaudeBasePath === getAutoDetectedClaudeBasePath() ? null : previousClaudeBasePath;
  const token = Symbol('TeamProvisioningHarnessPathOverride');
  setClaudeBasePathOverride(claudeRoot);
  activePathOverrideLease = {
    token,
    claudeRoot,
    previousClaudeBasePathOverride,
  };

  return () => {
    if (activePathOverrideLease?.token !== token) {
      throw new Error('TeamProvisioningHarnessBuilder path override cleanup is not active.');
    }

    activePathOverrideLease = null;
    setClaudeBasePathOverride(previousClaudeBasePathOverride);
  };
}

async function runCleanupFns(cleanupFns: readonly (() => Promise<void> | void)[]): Promise<void> {
  let firstError: unknown;
  for (const cleanupFn of [...cleanupFns].reverse()) {
    try {
      await cleanupFn();
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError) {
    throw firstError;
  }
}

class HarnessClock implements TeamProvisioningHarnessClock {
  private currentIso: string;

  constructor(isoOrDate: string | Date = HARNESS_DEFAULT_NOW_ISO) {
    this.currentIso = toIsoString(isoOrDate);
  }

  now(): Date {
    return new Date(this.currentIso);
  }

  nowIso(): string {
    return this.currentIso;
  }

  set(isoOrDate: string | Date): void {
    this.currentIso = toIsoString(isoOrDate);
  }
}

class HarnessUuidSource implements TeamProvisioningHarnessUuidSource {
  private index = 0;
  private readonly emitted: string[] = [];

  constructor(private readonly sequence: readonly string[] = []) {
    assertNoSecretLikeFixtureValues(sequence);
  }

  next(): string {
    const value = this.sequence[this.index] ?? `harness-uuid-${this.index + 1}`;
    this.index += 1;
    this.emitted.push(value);
    return value;
  }

  generated(): readonly string[] {
    return [...this.emitted];
  }
}

class TeamProvisioningHarnessImpl implements TeamProvisioningHarness {
  private cleaned = false;

  constructor(
    readonly teamName: string,
    readonly paths: TeamProvisioningHarnessPaths,
    readonly stores: TeamProvisioningHarnessStores,
    readonly clock: TeamProvisioningHarnessClock,
    readonly uuid: TeamProvisioningHarnessUuidSource,
    private readonly cleanupFns: readonly (() => Promise<void> | void)[]
  ) {}

  async cleanup(): Promise<void> {
    if (this.cleaned) {
      return;
    }

    this.cleaned = true;
    await runCleanupFns(this.cleanupFns);
  }
}

export class TeamProvisioningHarnessBuilder {
  private tempWorkspaceOptions: TempWorkspaceOptions = {};
  private defaultTeamName = HARNESS_DEFAULT_TEAM_NAME;
  private clockIso = HARNESS_DEFAULT_NOW_ISO;
  private uuidSequence: readonly string[] = [];
  private readonly teamConfigs = new Map<string, TeamConfig | null>();
  private readonly teamMeta = new Map<string, TeamMetaFile>();
  private readonly membersMeta = new Map<string, TeamMembersMetaFile>();

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

  async build(): Promise<TeamProvisioningHarness> {
    this.validateInputsBeforeSideEffects();

    const paths = await createTempWorkspace(this.tempWorkspaceOptions);
    const cleanupFns: (() => Promise<void> | void)[] = [
      () => rm(paths.root, { recursive: true, force: true }),
    ];

    try {
      if (this.tempWorkspaceOptions.applyPathOverride !== false) {
        cleanupFns.push(applyHarnessPathOverride(paths.claudeRoot));
      }

      const configs = this.createConfigFixtures(paths);
      const teamMeta = this.createTeamMetaFixtures(configs, paths);
      const membersMeta = this.createMembersMetaFixtures(configs);

      await writeHarnessFiles(paths, configs, teamMeta, membersMeta);

      const configReader = new FakeTeamConfigReader(configs.entries());
      const teamMetaStore = new FakeTeamMetaStore(teamMeta.entries());
      const membersMetaStore = new FakeTeamMembersMetaStore(membersMeta.entries());

      return new TeamProvisioningHarnessImpl(
        this.defaultTeamName,
        paths,
        {
          configReader: createConfigReaderPort(configReader),
          teamMetaStore: createTeamMetaStorePort(teamMetaStore),
          membersMetaStore: createMembersMetaStorePort(membersMetaStore),
        },
        new HarnessClock(this.clockIso),
        new HarnessUuidSource(this.uuidSequence),
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
  }

  private createConfigFixtures(paths: TeamProvisioningHarnessPaths): Map<string, TeamConfig> {
    const configInputs: ReadonlyMap<string, TeamConfig | null> =
      this.teamConfigs.size > 0
        ? this.teamConfigs
        : new Map([[this.defaultTeamName, null] as const]);
    const configs = new Map<string, TeamConfig>();

    for (const [teamName, config] of configInputs) {
      const resolvedConfig =
        config ??
        teamConfigFixture.basic({
          teamName,
          projectPath: paths.projectPath,
          members: [memberFixture.lead(), memberFixture.codex('Builder')],
        });
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
      const meta =
        this.teamMeta.get(teamName) ??
        teamMetaFixture.basic({
          displayName: config.name,
          description: config.description,
          color: config.color,
          cwd: config.projectPath ?? paths.projectPath,
          providerId: config.members?.[0]?.providerId ?? 'codex',
        });
      assertNoSecretLikeFixtureValues({ teamName, meta });
      metaByTeam.set(teamName, cloneFixture(meta));
    }

    return metaByTeam;
  }

  private createMembersMetaFixtures(
    configs: ReadonlyMap<string, TeamConfig>
  ): Map<string, TeamMembersMetaFile> {
    const metaByTeam = new Map<string, TeamMembersMetaFile>();

    for (const [teamName, config] of configs) {
      const meta =
        this.membersMeta.get(teamName) ??
        ({
          version: 1,
          members: config.members ?? [],
        } satisfies TeamMembersMetaFile);
      assertNoSecretLikeFixtureValues({ teamName, meta });
      metaByTeam.set(teamName, cloneFixture(meta));
    }

    return metaByTeam;
  }
}

function assertContainedPath(
  parentPath: string,
  childPath: string,
  label: string,
  parentLabel: string
): void {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${parentLabel}.`);
  }
}

const RESERVED_FILENAME_PATH_CHARS = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|']);

function hasUnsafePathCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const charCode = char.charCodeAt(0);
    if (
      charCode <= 31 ||
      (charCode >= 127 && charCode <= 159) ||
      RESERVED_FILENAME_PATH_CHARS.has(char)
    ) {
      return true;
    }
  }
  return false;
}

function assertPathSegment(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${label}: value must not be empty.`);
  }
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`Invalid ${label}: absolute paths are not allowed.`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`Invalid ${label}: path separators are not allowed.`);
  }
  if (value === '.' || value === '..') {
    throw new Error(`Invalid ${label}: path traversal is not allowed.`);
  }
  if (hasUnsafePathCharacter(value)) {
    throw new Error(`Invalid ${label}: unsafe path characters are not allowed.`);
  }
  if (
    path.normalize(value) !== value ||
    path.posix.normalize(value) !== value ||
    path.win32.normalize(value) !== value ||
    value.normalize('NFC') !== value
  ) {
    throw new Error(`Invalid ${label}: normalized value must match the original value.`);
  }
}

function validateTeamNamePathSegment(teamName: string): void {
  assertPathSegment(teamName, 'team name');
}

function validateMemberNamePathSegment(memberName: string): void {
  assertPathSegment(memberName, 'member name');
}

function validateMemberPathSegments(members: readonly TeamMember[] | undefined): void {
  for (const [index, member] of (members ?? []).entries()) {
    if (typeof member.name !== 'string') {
      throw new Error(`Invalid member name at members[${index}]: value must be a string.`);
    }
    validateMemberNamePathSegment(member.name);
  }
}

function validateConfigMemberPathSegments(config: TeamConfig | null): void {
  if (!config) {
    return;
  }
  validateMemberPathSegments(config.members);
}

function validateTempPathSegment(value: string, optionName: keyof TempWorkspaceOptions): void {
  assertPathSegment(value, `temp workspace ${optionName}`);
  if (value.includes('..')) {
    throw new Error(`Invalid temp workspace ${optionName}: parent traversal is not allowed.`);
  }
}

function validateTempWorkspaceOptions(options: TempWorkspaceOptions): void {
  validateTempPathSegment(options.prefix ?? DEFAULT_TEMP_WORKSPACE_PREFIX, 'prefix');
  validateTempPathSegment(options.projectDirName ?? DEFAULT_PROJECT_DIR_NAME, 'projectDirName');
}

function createPaths(root: string, projectDirName: string): TeamProvisioningHarnessPaths {
  const claudeRoot = path.join(root, '.claude');
  const teamsBase = path.join(claudeRoot, 'teams');
  const tasksBase = path.join(claudeRoot, 'tasks');
  const projectsBase = path.join(claudeRoot, 'projects');
  const projectPath = path.join(root, projectDirName);
  assertContainedPath(root, claudeRoot, 'claudeRoot', 'the harness temp root');
  assertContainedPath(root, teamsBase, 'teamsBase', 'the harness temp root');
  assertContainedPath(root, tasksBase, 'tasksBase', 'the harness temp root');
  assertContainedPath(root, projectsBase, 'projectsBase', 'the harness temp root');
  assertContainedPath(root, projectPath, 'projectDirName', 'the harness temp root');

  const teamPath = (teamName: string, label: string, ...segments: string[]): string => {
    validateTeamNamePathSegment(teamName);
    const candidate = path.join(teamsBase, teamName, ...segments);
    assertContainedPath(root, candidate, label, 'the harness temp root');
    assertContainedPath(teamsBase, candidate, label, 'the harness teams base');
    return candidate;
  };

  return {
    root,
    claudeRoot,
    teamsBase,
    tasksBase,
    projectsBase,
    projectPath,
    teamDir: (teamName) => teamPath(teamName, 'team directory'),
    configPath: (teamName) => teamPath(teamName, 'team config path', 'config.json'),
    teamMetaPath: (teamName) => teamPath(teamName, 'team meta path', 'team.meta.json'),
    membersMetaPath: (teamName) => teamPath(teamName, 'members meta path', 'members.meta.json'),
    inboxPath: (teamName, memberName) => {
      validateMemberNamePathSegment(memberName);
      return teamPath(teamName, 'member inbox path', 'inboxes', `${memberName}.json`);
    },
    launchStatePath: (teamName) => teamPath(teamName, 'launch state path', 'launch-state.json'),
    bootstrapStatePath: (teamName) =>
      teamPath(teamName, 'bootstrap state path', 'bootstrap', 'bootstrap-state.json'),
    runtimeStorePath: (teamName) =>
      teamPath(teamName, 'runtime store path', 'runtime', 'opencode-sessions.json'),
  };
}

async function createTempWorkspace(
  options: TempWorkspaceOptions
): Promise<TeamProvisioningHarnessPaths> {
  validateTempWorkspaceOptions(options);

  const prefix = options.prefix ?? DEFAULT_TEMP_WORKSPACE_PREFIX;
  const projectDirName = options.projectDirName ?? DEFAULT_PROJECT_DIR_NAME;
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = createPaths(root, projectDirName);

  try {
    await Promise.all([
      mkdir(paths.teamsBase, { recursive: true }),
      mkdir(paths.tasksBase, { recursive: true }),
      mkdir(paths.projectsBase, { recursive: true }),
      mkdir(paths.projectPath, { recursive: true }),
    ]);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return paths;
}

async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  assertNoSecretLikeFixtureValues(payload);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function writeHarnessFiles(
  paths: TeamProvisioningHarnessPaths,
  configs: ReadonlyMap<string, TeamConfig>,
  teamMeta: ReadonlyMap<string, TeamMetaFile>,
  membersMeta: ReadonlyMap<string, TeamMembersMetaFile>
): Promise<void> {
  for (const [teamName, config] of configs) {
    await writeJsonFile(paths.configPath(teamName), config);
  }

  for (const [teamName, meta] of teamMeta) {
    await writeJsonFile(paths.teamMetaPath(teamName), meta);
  }

  for (const [teamName, meta] of membersMeta) {
    await writeJsonFile(paths.membersMetaPath(teamName), meta);
  }
}
