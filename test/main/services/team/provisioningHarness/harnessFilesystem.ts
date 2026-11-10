/* eslint-disable security/detect-non-literal-fs-filename -- Test harness paths are created under mkdtemp. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { assertNoSecretLikeFixtureValues } from './fixtures';
import { normalizeMembers } from './harnessData';

import type { TeamProvisioningConfigMaintenanceReadOptions } from '@main/services/team/provisioning/TeamProvisioningConfigMaintenance';
import type { TeamMembersMetaFile } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaFile } from '@main/services/team/TeamMetaStore';
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

export interface TempWorkspaceOptions {
  prefix?: string;
  projectDirName?: string;
  applyPathOverride?: boolean;
}

export interface HarnessStateFileFixtures {
  inboxMessages: ReadonlyMap<string, ReadonlyMap<string, readonly unknown[]>>;
  launchStates: ReadonlyMap<string, unknown>;
  bootstrapStates: ReadonlyMap<string, unknown>;
  runtimeStores: ReadonlyMap<string, unknown>;
}

export function assertContainedPath(
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

function assertTrimmedPathSegmentIfPresent(value: string, label: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === value) {
    return;
  }
  assertPathSegment(trimmed, label);
}

export function validateTeamNamePathSegment(teamName: string): void {
  assertPathSegment(teamName, 'team name');
  const trimmed = teamName.trim();
  if (trimmed !== teamName) {
    assertPathSegment(trimmed, 'team name');
  }
}

export function validateMemberNamePathSegment(memberName: string): void {
  assertPathSegment(memberName, 'member name');
  assertTrimmedPathSegmentIfPresent(memberName, 'member name');
}

export function validateStoredMemberPathSegments(members: readonly TeamMember[] | undefined): void {
  for (const [index, member] of (members ?? []).entries()) {
    if (typeof member.name !== 'string') {
      throw new Error(`Invalid member name at members[${index}]: value must be a string.`);
    }
    validateMemberNamePathSegment(member.name);
  }
}

export function validateMemberPathSegments(members: readonly TeamMember[] | undefined): void {
  for (const [index, member] of (members ?? []).entries()) {
    if (typeof member.name !== 'string') {
      throw new Error(`Invalid member name at members[${index}]: value must be a string.`);
    }
    assertPathSegment(member.name, 'member name');
  }
  validateStoredMemberPathSegments(normalizeMembers(members ?? []));
}

export function validateConfigMemberPathSegments(config: TeamConfig | null): void {
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

export function validateTempWorkspaceOptions(options: TempWorkspaceOptions): void {
  validateTempPathSegment(options.prefix ?? DEFAULT_TEMP_WORKSPACE_PREFIX, 'prefix');
  validateTempPathSegment(options.projectDirName ?? DEFAULT_PROJECT_DIR_NAME, 'projectDirName');
}

export function createPaths(root: string, projectDirName: string): TeamProvisioningHarnessPaths {
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

export async function createTempWorkspace(
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

export function assertValidJsonFixture(value: unknown, label: string): void {
  if (value === undefined) {
    throw new Error(`${label} must be JSON-serializable; undefined is not allowed.`);
  }
  assertNoSecretLikeFixtureValues(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`${label} must be JSON-serializable.`);
  }
}

export async function writeJsonFile(filePath: string, payload: unknown): Promise<void> {
  assertValidJsonFixture(payload, 'harness JSON fixture');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function writeHarnessFiles(
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

export async function writeHarnessStateFiles(
  paths: TeamProvisioningHarnessPaths,
  fixtures: HarnessStateFileFixtures
): Promise<void> {
  for (const [teamName, snapshot] of fixtures.launchStates) {
    await writeJsonFile(paths.launchStatePath(teamName), snapshot);
  }

  for (const [teamName, snapshot] of fixtures.bootstrapStates) {
    await writeJsonFile(paths.bootstrapStatePath(teamName), snapshot);
  }

  for (const [teamName, store] of fixtures.runtimeStores) {
    await writeJsonFile(paths.runtimeStorePath(teamName), store);
  }

  for (const [teamName, inboxes] of fixtures.inboxMessages) {
    for (const [memberName, messages] of inboxes) {
      await writeJsonFile(paths.inboxPath(teamName, memberName), messages);
    }
  }
}

export async function readHarnessJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function readHarnessRegularFileUtf8(
  paths: TeamProvisioningHarnessPaths,
  filePath: string,
  _options: TeamProvisioningConfigMaintenanceReadOptions
): Promise<string | null> {
  assertContainedPath(paths.root, filePath, 'readRegularFileUtf8 path', 'the harness temp root');
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
