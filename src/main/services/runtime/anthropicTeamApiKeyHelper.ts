import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { execFile, execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_ENV = 'CLAUDE_TEAM_ANTHROPIC_AUTH_MODE';
export const CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER = 'api_key_helper';
export const CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH_ENV =
  'CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH';
export const DISABLE_ANTHROPIC_TEAM_API_KEY_HELPER_ENV =
  'CLAUDE_TEAM_DISABLE_ANTHROPIC_API_KEY_HELPER';

export const ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
] as const;

export interface AnthropicTeamApiKeyHelperMaterial {
  teamName: string;
  directory: string;
  helperPath: string;
  keyPath: string;
  settingsPath: string;
  settingsObject: { apiKeyHelper: string };
  settingsArgs: string[];
  envPatch: NodeJS.ProcessEnv;
}

function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isOwnedPathSegment(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,128}$/.test(value) && value !== '.' && value !== '..';
}

function safePathSegment(value: string): string {
  const trimmed = value.trim();
  if (isOwnedPathSegment(trimmed)) {
    return trimmed;
  }
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function buildAnthropicTeamAuthDirectoryName(teamName: string): string {
  const slug =
    teamName
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'team';
  const hash = crypto.createHash('sha256').update(teamName).digest('hex').slice(0, 12);
  return `${slug}-${hash}`;
}

function resolveInside(basePath: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(basePath);
  const resolvedPath = path.resolve(resolvedBase, ...segments);
  const relative = path.relative(resolvedBase, resolvedPath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedPath;
  }
  throw new Error('Refusing to write Anthropic team auth material outside the auth root');
}

async function ensureOwnedDirectory(dirPath: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe Anthropic team auth directory: ${dirPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    await fs.promises.chmod(dirPath, 0o700).catch(() => undefined);
  }
}

async function assertRegularOwnedFile(filePath: string, mode: number): Promise<void> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe Anthropic team auth file: ${filePath}`);
  }
  if (process.platform !== 'win32') {
    await fs.promises.chmod(filePath, mode).catch(() => undefined);
  }
}

function readLiveProcessCommandsForReferenceCheck(): string | null {
  if (process.platform === 'win32') {
    return null;
  }
  try {
    return execFileSync('ps', ['-ax', '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function liveProcessMayReferencePath(targetPath: string, processCommands?: string | null): boolean {
  const output =
    processCommands !== undefined ? processCommands : readLiveProcessCommandsForReferenceCheck();
  return typeof output === 'string' && output.includes(targetPath);
}

async function writeFileAtomic(filePath: string, contents: string, mode: number): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureOwnedDirectory(dir);
  const existing = await fs.promises.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked Anthropic team auth file: ${filePath}`);
  }
  await atomicWriteAsync(filePath, contents, { mode });
  if (process.platform !== 'win32') {
    await fs.promises.chmod(filePath, mode).catch(() => undefined);
  }
  await assertRegularOwnedFile(filePath, mode);
}

function buildHelperScript(keyPath: string): string {
  return [
    '#!/bin/sh',
    'set -eu',
    `KEY_FILE=${shellQuote(keyPath)}`,
    'if [ ! -r "$KEY_FILE" ]; then',
    "  echo 'app-managed Anthropic API key is unavailable' >&2",
    '  exit 1',
    'fi',
    'key="$(cat "$KEY_FILE")"',
    'if [ -z "$key" ]; then',
    "  echo 'app-managed Anthropic API key is empty' >&2",
    '  exit 1',
    'fi',
    'printf \'%s\\n\' "$key"',
    '',
  ].join('\n');
}

function buildAuthMaterialPaths(input: {
  teamName: string;
  authMaterialId: string;
  baseClaudeDir: string;
}): { authRoot: string; teamDir: string; runDir: string } {
  const authRoot = path.resolve(input.baseClaudeDir, 'team-runtime-auth');
  const teamDirName = buildAnthropicTeamAuthDirectoryName(input.teamName);
  const authMaterialSegment = safePathSegment(input.authMaterialId);
  const teamDir = resolveInside(authRoot, teamDirName);
  const runDir = resolveInside(authRoot, teamDirName, 'runs', authMaterialSegment);
  return { authRoot, teamDir, runDir };
}

export async function materializeAnthropicTeamApiKeyHelper(input: {
  teamName: string;
  authMaterialId: string;
  apiKey: string;
  baseClaudeDir: string;
}): Promise<AnthropicTeamApiKeyHelperMaterial> {
  const normalizedApiKey = input.apiKey.trim();
  if (!normalizedApiKey) {
    throw new Error('Cannot materialize Anthropic team API-key helper without an API key');
  }

  const { authRoot, teamDir, runDir } = buildAuthMaterialPaths(input);
  await ensureOwnedDirectory(authRoot);
  await ensureOwnedDirectory(teamDir);
  await ensureOwnedDirectory(path.join(teamDir, 'runs'));
  await ensureOwnedDirectory(runDir);

  const keyPath = path.join(runDir, 'key');
  const helperPath = path.join(runDir, 'helper.sh');
  const settingsPath = path.join(runDir, 'settings.json');
  const settingsObject = { apiKeyHelper: shellQuote(helperPath) };

  await writeFileAtomic(keyPath, `${normalizedApiKey}\n`, 0o600);
  await writeFileAtomic(helperPath, buildHelperScript(keyPath), 0o700);
  await writeFileAtomic(settingsPath, `${JSON.stringify(settingsObject, null, 2)}\n`, 0o600);

  return {
    teamName: input.teamName,
    directory: runDir,
    helperPath,
    keyPath,
    settingsPath,
    settingsObject,
    settingsArgs: ['--settings', settingsPath],
    envPatch: {
      [CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_ENV]: CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER,
      [CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH_ENV]: settingsPath,
    },
  };
}

export async function verifyAnthropicTeamApiKeyHelperMaterial(input: {
  helperPath: string;
  expectedApiKey: string;
  timeoutMs?: number;
}): Promise<void> {
  const result = await execFileAsync('/bin/sh', ['-c', shellQuote(input.helperPath)], {
    timeout: input.timeoutMs ?? 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.stdout.trim() !== input.expectedApiKey.trim()) {
    throw new Error('App-managed Anthropic API-key helper verification failed');
  }
}

export async function cleanupAnthropicTeamApiKeyHelperMaterial(input: {
  directory: string;
  skipIfLiveProcessReferences?: boolean;
}): Promise<void> {
  if (input.skipIfLiveProcessReferences === true && liveProcessMayReferencePath(input.directory)) {
    return;
  }
  const entries = await fs.promises
    .readdir(input.directory, { withFileTypes: true })
    .catch(() => []);
  const expected = new Set(['helper.sh', 'key', 'settings.json']);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const fileName = entry.name;
    const isExpected =
      expected.has(fileName) || /^runtime-settings-[a-zA-Z0-9._-]+\.json$/.test(fileName);
    if (!isExpected) {
      continue;
    }
    const filePath = path.join(input.directory, fileName);
    const stat = await fs.promises.lstat(filePath).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
  }
  await fs.promises.rmdir(input.directory).catch(() => undefined);
}

export async function cleanupAnthropicTeamApiKeyHelperForTeam(input: {
  teamName: string;
  baseClaudeDir: string;
}): Promise<void> {
  const { teamDir } = buildAuthMaterialPaths({
    teamName: input.teamName,
    authMaterialId: 'cleanup-placeholder',
    baseClaudeDir: input.baseClaudeDir,
  });
  const stat = await fs.promises.lstat(teamDir).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    return;
  }
  const processCommands = readLiveProcessCommandsForReferenceCheck();
  const runsDir = path.join(teamDir, 'runs');
  const runsStat = await fs.promises.lstat(runsDir).catch(() => null);
  if (runsStat?.isDirectory() && !runsStat.isSymbolicLink()) {
    const entries = await fs.promises.readdir(runsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !isOwnedPathSegment(entry.name)) {
        continue;
      }
      const runDir = path.join(runsDir, entry.name);
      const runStat = await fs.promises.lstat(runDir).catch(() => null);
      if (!runStat?.isDirectory() || runStat.isSymbolicLink()) {
        continue;
      }
      if (liveProcessMayReferencePath(runDir, processCommands)) {
        continue;
      }
      await cleanupAnthropicTeamApiKeyHelperMaterial({ directory: runDir });
    }
    await fs.promises.rmdir(runsDir).catch(() => undefined);
  }
  await fs.promises.rmdir(teamDir).catch(() => undefined);
}

export async function cleanupStaleAnthropicTeamApiKeyHelpers(input: {
  baseClaudeDir: string;
  maxAgeMs: number;
}): Promise<void> {
  const authRoot = path.resolve(input.baseClaudeDir, 'team-runtime-auth');
  const rootStat = await fs.promises.lstat(authRoot).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    return;
  }

  const now = Date.now();
  const processCommands = readLiveProcessCommandsForReferenceCheck();
  if (processCommands === null) {
    return;
  }
  const teamEntries = await fs.promises.readdir(authRoot, { withFileTypes: true }).catch(() => []);
  for (const teamEntry of teamEntries) {
    if (!teamEntry.isDirectory() || !isOwnedPathSegment(teamEntry.name)) {
      continue;
    }
    const teamDir = path.join(authRoot, teamEntry.name);
    const teamStat = await fs.promises.lstat(teamDir).catch(() => null);
    if (!teamStat?.isDirectory() || teamStat.isSymbolicLink()) {
      continue;
    }
    const runsDir = path.join(teamDir, 'runs');
    const runsStat = await fs.promises.lstat(runsDir).catch(() => null);
    if (!runsStat?.isDirectory() || runsStat.isSymbolicLink()) {
      continue;
    }
    const runEntries = await fs.promises.readdir(runsDir, { withFileTypes: true }).catch(() => []);
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory() || !isOwnedPathSegment(runEntry.name)) {
        continue;
      }
      const runDir = path.join(runsDir, runEntry.name);
      const runStat = await fs.promises.lstat(runDir).catch(() => null);
      if (!runStat?.isDirectory() || runStat.isSymbolicLink()) {
        continue;
      }
      if (now - runStat.mtimeMs < input.maxAgeMs) {
        continue;
      }
      if (liveProcessMayReferencePath(runDir, processCommands)) {
        continue;
      }
      await cleanupAnthropicTeamApiKeyHelperMaterial({ directory: runDir });
    }
    await fs.promises.rmdir(runsDir).catch(() => undefined);
    await fs.promises.rmdir(teamDir).catch(() => undefined);
  }
}
